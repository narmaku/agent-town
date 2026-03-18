import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { formatEntry, type JsonlEntry } from "./session-messages";

function makeEntry(overrides: Partial<JsonlEntry> & { type: string }): JsonlEntry {
  return {
    sessionId: "test-session-id",
    timestamp: new Date().toISOString(),
    message: { role: overrides.type === "user" ? "user" : "assistant" },
    ...overrides,
  };
}

describe("formatEntry", () => {
  test("formats string content", () => {
    const entry = makeEntry({
      type: "user",
      message: { role: "user", content: "Hello world" },
    });
    const result = formatEntry(entry);
    expect(result.role).toBe("user");
    expect(result.content).toBe("Hello world");
    expect(result.toolUse).toBeUndefined();
    expect(result.toolResult).toBeUndefined();
  });

  test("formats array content with text blocks", () => {
    const entry = makeEntry({
      type: "assistant",
      message: {
        role: "assistant",
        model: "claude-sonnet-4-5-20250514",
        content: [
          { type: "text", text: "First paragraph" },
          { type: "text", text: "Second paragraph" },
        ],
      },
    });
    const result = formatEntry(entry);
    expect(result.content).toBe("First paragraph\n\nSecond paragraph");
    expect(result.model).toBe("claude-sonnet-4-5-20250514");
  });

  test("extracts tool_use blocks", () => {
    const entry = makeEntry({
      type: "assistant",
      message: {
        role: "assistant",
        content: [
          { type: "text", text: "Let me check..." },
          { type: "tool_use", name: "Read", id: "tool_123" },
        ],
      },
    });
    const result = formatEntry(entry);
    expect(result.content).toBe("Let me check...");
    expect(result.toolUse).toEqual([{ name: "Read", id: "tool_123" }]);
  });

  test("skips tool_use blocks with missing name or id", () => {
    const entry = makeEntry({
      type: "assistant",
      message: {
        role: "assistant",
        content: [{ type: "tool_use", name: "Read" }],
      },
    });
    const result = formatEntry(entry);
    expect(result.toolUse).toBeUndefined();
  });

  test("extracts tool_result string content", () => {
    const entry = makeEntry({
      type: "user",
      message: {
        role: "user",
        content: [{ type: "tool_result", content: "file contents here" }],
      },
    });
    const result = formatEntry(entry);
    expect(result.toolResult).toBe("file contents here");
  });

  test("truncates long tool_result to 500 chars", () => {
    const longContent = "x".repeat(600);
    const entry = makeEntry({
      type: "user",
      message: {
        role: "user",
        content: [{ type: "tool_result", content: longContent }],
      },
    });
    const result = formatEntry(entry);
    expect(result.toolResult).toHaveLength(500);
  });

  test("handles tool_result with non-string content", () => {
    const entry = makeEntry({
      type: "user",
      message: {
        role: "user",
        content: [{ type: "tool_result", content: { complex: "object" } }],
      },
    });
    const result = formatEntry(entry);
    expect(result.toolResult).toBe("[tool output]");
  });

  test("handles empty content", () => {
    const entry = makeEntry({
      type: "assistant",
      message: { role: "assistant" },
    });
    const result = formatEntry(entry);
    expect(result.content).toBe("");
  });

  test("handles empty array content", () => {
    const entry = makeEntry({
      type: "assistant",
      message: { role: "assistant", content: [] },
    });
    const result = formatEntry(entry);
    expect(result.content).toBe("");
    expect(result.toolUse).toBeUndefined();
  });

  test("preserves timestamp and model", () => {
    const ts = "2025-01-15T12:00:00Z";
    const entry = makeEntry({
      type: "assistant",
      timestamp: ts,
      message: { role: "assistant", model: "claude-opus-4-6", content: "hi" },
    });
    const result = formatEntry(entry);
    expect(result.timestamp).toBe(ts);
    expect(result.model).toBe("claude-opus-4-6");
  });
});

describe("getSessionMessages", () => {
  let tempDir: string;
  let projectsDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "session-msg-test-"));
    projectsDir = join(tempDir, ".claude", "projects", "test-project");
    mkdirSync(projectsDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  // We can't easily test getSessionMessages directly because it uses homedir()
  // to find files. The formatEntry tests above cover the parsing logic.
  // Integration testing of the full flow is done via the terminal-server API tests.

  test("formatEntry handles mixed content blocks correctly", () => {
    const entry = makeEntry({
      type: "assistant",
      message: {
        role: "assistant",
        content: [
          { type: "text", text: "I'll read the file" },
          { type: "tool_use", name: "Read", id: "t1" },
          { type: "text", text: "Here are the results" },
        ],
      },
    });
    const result = formatEntry(entry);
    expect(result.content).toBe("I'll read the file\n\nHere are the results");
    expect(result.toolUse).toEqual([{ name: "Read", id: "t1" }]);
  });

  test("formatEntry handles multiple tool_use blocks", () => {
    const entry = makeEntry({
      type: "assistant",
      message: {
        role: "assistant",
        content: [
          { type: "tool_use", name: "Read", id: "t1" },
          { type: "tool_use", name: "Edit", id: "t2" },
          { type: "tool_use", name: "Bash", id: "t3" },
        ],
      },
    });
    const result = formatEntry(entry);
    expect(result.toolUse).toHaveLength(3);
    expect(result.toolUse?.[0].name).toBe("Read");
    expect(result.toolUse?.[2].name).toBe("Bash");
  });
});
