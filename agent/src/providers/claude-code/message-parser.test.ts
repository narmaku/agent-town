import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type ClaudeMessageEntry, formatClaudeEntry } from "./message-parser";

function makeEntry(overrides: Partial<ClaudeMessageEntry> = {}): ClaudeMessageEntry {
  return {
    type: "assistant",
    sessionId: "test-session-id",
    timestamp: "2026-03-19T10:00:00Z",
    message: {
      role: "assistant",
      model: "claude-opus-4-6",
      content: [{ type: "text", text: "Hello from the assistant." }],
    },
    ...overrides,
  };
}

describe("formatClaudeEntry", () => {
  test("formats string content", () => {
    const entry = makeEntry({
      type: "user",
      message: { role: "user", content: "Hello world" },
    });
    const result = formatClaudeEntry(entry);
    expect(result.role).toBe("user");
    expect(result.content).toBe("Hello world");
    expect(result.toolUse).toBeUndefined();
    expect(result.toolResult).toBeUndefined();
  });

  test("formats array content with a single text block", () => {
    const entry = makeEntry({
      message: {
        role: "assistant",
        content: [{ type: "text", text: "One paragraph" }],
      },
    });
    const result = formatClaudeEntry(entry);
    expect(result.content).toBe("One paragraph");
  });

  test("joins multiple text blocks with double newline", () => {
    const entry = makeEntry({
      message: {
        role: "assistant",
        content: [
          { type: "text", text: "First paragraph" },
          { type: "text", text: "Second paragraph" },
        ],
      },
    });
    const result = formatClaudeEntry(entry);
    expect(result.content).toBe("First paragraph\n\nSecond paragraph");
  });

  test("extracts tool_use blocks with name and id", () => {
    const entry = makeEntry({
      message: {
        role: "assistant",
        content: [
          { type: "text", text: "Let me read the file" },
          { type: "tool_use", name: "Read", id: "tool_abc" },
        ],
      },
    });
    const result = formatClaudeEntry(entry);
    expect(result.content).toBe("Let me read the file");
    expect(result.toolUse).toEqual([{ name: "Read", id: "tool_abc" }]);
  });

  test("extracts multiple tool_use blocks", () => {
    const entry = makeEntry({
      message: {
        role: "assistant",
        content: [
          { type: "tool_use", name: "Read", id: "t1" },
          { type: "tool_use", name: "Edit", id: "t2" },
          { type: "tool_use", name: "Bash", id: "t3" },
        ],
      },
    });
    const result = formatClaudeEntry(entry);
    expect(result.toolUse).toHaveLength(3);
    expect(result.toolUse?.[0]).toEqual({ name: "Read", id: "t1" });
    expect(result.toolUse?.[1]).toEqual({ name: "Edit", id: "t2" });
    expect(result.toolUse?.[2]).toEqual({ name: "Bash", id: "t3" });
  });

  test("skips tool_use blocks missing name", () => {
    const entry = makeEntry({
      message: {
        role: "assistant",
        content: [{ type: "tool_use", id: "t1" }],
      },
    });
    const result = formatClaudeEntry(entry);
    expect(result.toolUse).toBeUndefined();
  });

  test("skips tool_use blocks missing id", () => {
    const entry = makeEntry({
      message: {
        role: "assistant",
        content: [{ type: "tool_use", name: "Read" }],
      },
    });
    const result = formatClaudeEntry(entry);
    expect(result.toolUse).toBeUndefined();
  });

  test("extracts tool_result with string content", () => {
    const entry = makeEntry({
      type: "user",
      message: {
        role: "user",
        content: [{ type: "tool_result", content: "file contents here" }],
      },
    });
    const result = formatClaudeEntry(entry);
    expect(result.toolResult).toBe("file contents here");
  });

  test("truncates tool_result string content to 500 characters", () => {
    const longContent = "a".repeat(600);
    const entry = makeEntry({
      type: "user",
      message: {
        role: "user",
        content: [{ type: "tool_result", content: longContent }],
      },
    });
    const result = formatClaudeEntry(entry);
    expect(result.toolResult).toHaveLength(500);
  });

  test("uses [tool output] for tool_result with non-string content", () => {
    const entry = makeEntry({
      type: "user",
      message: {
        role: "user",
        content: [{ type: "tool_result", content: { complex: "object" } }],
      },
    });
    const result = formatClaudeEntry(entry);
    expect(result.toolResult).toBe("[tool output]");
  });

  test("uses [tool output] for tool_result with undefined content", () => {
    const entry = makeEntry({
      type: "user",
      message: {
        role: "user",
        content: [{ type: "tool_result" }],
      },
    });
    const result = formatClaudeEntry(entry);
    expect(result.toolResult).toBe("[tool output]");
  });

  test("handles mixed text, tool_use, and tool_result blocks", () => {
    const entry = makeEntry({
      message: {
        role: "assistant",
        content: [
          { type: "text", text: "Analyzing the code" },
          { type: "tool_use", name: "Grep", id: "grep_1" },
          { type: "tool_result", content: "match found on line 42" },
          { type: "text", text: "Found the issue" },
        ],
      },
    });
    const result = formatClaudeEntry(entry);
    expect(result.content).toBe("Analyzing the code\n\nFound the issue");
    expect(result.toolUse).toEqual([{ name: "Grep", id: "grep_1" }]);
    expect(result.toolResult).toBe("match found on line 42");
  });

  test("returns empty content when content is undefined", () => {
    const entry = makeEntry({
      message: { role: "assistant" },
    });
    const result = formatClaudeEntry(entry);
    expect(result.content).toBe("");
    expect(result.toolUse).toBeUndefined();
    expect(result.toolResult).toBeUndefined();
  });

  test("returns empty content for empty array", () => {
    const entry = makeEntry({
      message: { role: "assistant", content: [] },
    });
    const result = formatClaudeEntry(entry);
    expect(result.content).toBe("");
    expect(result.toolUse).toBeUndefined();
    expect(result.toolResult).toBeUndefined();
  });

  test("returns empty content for non-string non-array content", () => {
    const entry = makeEntry({
      message: { role: "assistant", content: 42 },
    });
    const result = formatClaudeEntry(entry);
    expect(result.content).toBe("");
  });

  test("preserves timestamp from entry", () => {
    const ts = "2026-01-15T08:30:00Z";
    const entry = makeEntry({ timestamp: ts });
    const result = formatClaudeEntry(entry);
    expect(result.timestamp).toBe(ts);
  });

  test("preserves model from message", () => {
    const entry = makeEntry({
      message: { role: "assistant", model: "claude-sonnet-4-5-20250514", content: "hi" },
    });
    const result = formatClaudeEntry(entry);
    expect(result.model).toBe("claude-sonnet-4-5-20250514");
  });

  test("model is undefined when not present in message", () => {
    const entry = makeEntry({
      type: "user",
      message: { role: "user", content: "hello" },
    });
    const result = formatClaudeEntry(entry);
    expect(result.model).toBeUndefined();
  });

  test("uses entry.type as the role in the output", () => {
    const entry = makeEntry({ type: "user" });
    const result = formatClaudeEntry(entry);
    expect(result.role).toBe("user");
  });

  test("handles content blocks with unrecognized types gracefully", () => {
    const entry = makeEntry({
      message: {
        role: "assistant",
        content: [
          { type: "image", source: "data:image/png;base64,..." },
          { type: "text", text: "Here is the result" },
        ],
      },
    });
    const result = formatClaudeEntry(entry);
    expect(result.content).toBe("Here is the result");
    expect(result.toolUse).toBeUndefined();
    expect(result.toolResult).toBeUndefined();
  });

  test("handles text block with non-string text property", () => {
    const entry = makeEntry({
      message: {
        role: "assistant",
        content: [{ type: "text", text: 123 }],
      },
    });
    const result = formatClaudeEntry(entry);
    expect(result.content).toBe("");
  });

  test("handles empty string content", () => {
    const entry = makeEntry({
      message: { role: "user", content: "" },
    });
    const result = formatClaudeEntry(entry);
    expect(result.content).toBe("");
  });

  test("tool_result exactly at 500 characters is not truncated", () => {
    const exactContent = "b".repeat(500);
    const entry = makeEntry({
      type: "user",
      message: {
        role: "user",
        content: [{ type: "tool_result", content: exactContent }],
      },
    });
    const result = formatClaudeEntry(entry);
    expect(result.toolResult).toHaveLength(500);
    expect(result.toolResult).toBe(exactContent);
  });

  // --- Thinking block tests ---

  test("extracts a single thinking block", () => {
    const entry = makeEntry({
      message: {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "Let me analyze this problem step by step." },
          { type: "text", text: "Here is my answer." },
        ],
      },
    });
    const result = formatClaudeEntry(entry);
    expect(result.thinking).toBe("Let me analyze this problem step by step.");
    expect(result.content).toBe("Here is my answer.");
  });

  test("joins multiple thinking blocks with double newline", () => {
    const entry = makeEntry({
      message: {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "First thought." },
          { type: "thinking", thinking: "Second thought." },
          { type: "text", text: "Final answer." },
        ],
      },
    });
    const result = formatClaudeEntry(entry);
    expect(result.thinking).toBe("First thought.\n\nSecond thought.");
    expect(result.content).toBe("Final answer.");
  });

  test("thinking is undefined when no thinking blocks exist", () => {
    const entry = makeEntry({
      message: {
        role: "assistant",
        content: [{ type: "text", text: "No thinking here." }],
      },
    });
    const result = formatClaudeEntry(entry);
    expect(result.thinking).toBeUndefined();
  });

  test("skips thinking blocks with non-string thinking property", () => {
    const entry = makeEntry({
      message: {
        role: "assistant",
        content: [
          { type: "thinking", thinking: 42 },
          { type: "text", text: "Result." },
        ],
      },
    });
    const result = formatClaudeEntry(entry);
    expect(result.thinking).toBeUndefined();
  });

  // --- Tool input extraction tests ---

  test("extracts tool_use input as JSON string", () => {
    const entry = makeEntry({
      message: {
        role: "assistant",
        content: [
          {
            type: "tool_use",
            name: "Read",
            id: "tool_1",
            input: { file_path: "/home/user/file.ts" },
          },
        ],
      },
    });
    const result = formatClaudeEntry(entry);
    expect(result.toolUse).toHaveLength(1);
    expect(result.toolUse?.[0].input).toBeDefined();
    const parsed = JSON.parse(result.toolUse![0].input!);
    expect(parsed.file_path).toBe("/home/user/file.ts");
  });

  test("truncates tool_use input to 2000 characters", () => {
    const longInput = { data: "x".repeat(3000) };
    const entry = makeEntry({
      message: {
        role: "assistant",
        content: [{ type: "tool_use", name: "Bash", id: "tool_2", input: longInput }],
      },
    });
    const result = formatClaudeEntry(entry);
    expect(result.toolUse?.[0].input).toBeDefined();
    expect(result.toolUse![0].input!.length).toBeLessThanOrEqual(2000);
  });

  test("tool_use input is undefined when input is not provided", () => {
    const entry = makeEntry({
      message: {
        role: "assistant",
        content: [{ type: "tool_use", name: "Read", id: "tool_3" }],
      },
    });
    const result = formatClaudeEntry(entry);
    expect(result.toolUse?.[0].input).toBeUndefined();
  });

  // --- Multiple tool results tests ---

  test("collects multiple tool_result blocks into toolResults array", () => {
    const entry = makeEntry({
      type: "user",
      message: {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "tool_1", content: "Result one" },
          { type: "tool_result", tool_use_id: "tool_2", content: "Result two" },
        ],
      },
    });
    const result = formatClaudeEntry(entry);
    expect(result.toolResults).toHaveLength(2);
    expect(result.toolResults?.[0]).toEqual({ toolUseId: "tool_1", content: "Result one" });
    expect(result.toolResults?.[1]).toEqual({ toolUseId: "tool_2", content: "Result two" });
  });

  test("handles tool_result with array content (text blocks inside)", () => {
    const entry = makeEntry({
      type: "user",
      message: {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "tool_5",
            content: [
              { type: "text", text: "Line one" },
              { type: "text", text: "Line two" },
            ],
          },
        ],
      },
    });
    const result = formatClaudeEntry(entry);
    expect(result.toolResults).toHaveLength(1);
    expect(result.toolResults?.[0].content).toBe("Line one\nLine two");
    expect(result.toolResults?.[0].toolUseId).toBe("tool_5");
  });

  test("truncates tool_result content to 2000 characters in toolResults", () => {
    const longContent = "z".repeat(3000);
    const entry = makeEntry({
      type: "user",
      message: {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "tool_6", content: longContent }],
      },
    });
    const result = formatClaudeEntry(entry);
    expect(result.toolResults?.[0].content.length).toBeLessThanOrEqual(2000);
  });

  test("toolResults is undefined when no tool_result blocks exist", () => {
    const entry = makeEntry({
      message: {
        role: "assistant",
        content: [{ type: "text", text: "No tools." }],
      },
    });
    const result = formatClaudeEntry(entry);
    expect(result.toolResults).toBeUndefined();
  });

  // --- Mixed content tests ---

  // --- Token usage extraction tests ---

  test("extracts token usage from message.usage", () => {
    const entry = makeEntry({
      message: {
        role: "assistant",
        model: "claude-opus-4-6",
        content: [{ type: "text", text: "Hello" }],
        usage: { input_tokens: 100, output_tokens: 50 },
      },
    });
    const result = formatClaudeEntry(entry);
    expect(result.tokenUsage).toBeDefined();
    expect(result.tokenUsage?.inputTokens).toBe(100);
    expect(result.tokenUsage?.outputTokens).toBe(50);
  });

  test("extracts token usage with only input_tokens", () => {
    const entry = makeEntry({
      message: {
        role: "assistant",
        content: "Hi",
        usage: { input_tokens: 200 },
      },
    });
    const result = formatClaudeEntry(entry);
    expect(result.tokenUsage).toBeDefined();
    expect(result.tokenUsage?.inputTokens).toBe(200);
    expect(result.tokenUsage?.outputTokens).toBeUndefined();
  });

  test("extracts token usage with only output_tokens", () => {
    const entry = makeEntry({
      message: {
        role: "assistant",
        content: "Hi",
        usage: { output_tokens: 300 },
      },
    });
    const result = formatClaudeEntry(entry);
    expect(result.tokenUsage).toBeDefined();
    expect(result.tokenUsage?.inputTokens).toBeUndefined();
    expect(result.tokenUsage?.outputTokens).toBe(300);
  });

  test("tokenUsage is undefined when usage is not present", () => {
    const entry = makeEntry({
      message: { role: "assistant", content: "Hello" },
    });
    const result = formatClaudeEntry(entry);
    expect(result.tokenUsage).toBeUndefined();
  });

  test("tokenUsage is undefined when usage has no numeric tokens", () => {
    const entry = makeEntry({
      message: {
        role: "assistant",
        content: "Hello",
        usage: {},
      },
    });
    const result = formatClaudeEntry(entry);
    expect(result.tokenUsage).toBeUndefined();
  });

  test("handles message with text, thinking, tool calls, and tool results", () => {
    const entry = makeEntry({
      message: {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "I need to read the file." },
          { type: "text", text: "Let me check that file." },
          { type: "tool_use", name: "Read", id: "tool_r1", input: { path: "/tmp/test.ts" } },
          { type: "tool_result", tool_use_id: "tool_r1", content: "file contents" },
        ],
      },
    });
    const result = formatClaudeEntry(entry);
    expect(result.thinking).toBe("I need to read the file.");
    expect(result.content).toBe("Let me check that file.");
    expect(result.toolUse).toHaveLength(1);
    expect(result.toolUse?.[0].name).toBe("Read");
    expect(result.toolUse?.[0].input).toBeDefined();
    expect(result.toolResults).toHaveLength(1);
    expect(result.toolResults?.[0].toolUseId).toBe("tool_r1");
    expect(result.toolResult).toBe("file contents");
  });
});

describe("getClaudeSessionMessages", () => {
  let tempDir: string;
  let projectsDir: string;

  function writeJsonlFile(sessionId: string, entries: unknown[]): void {
    const content = entries.map((e) => JSON.stringify(e)).join("\n");
    writeFileSync(join(projectsDir, `${sessionId}.jsonl`), content);
  }

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "claude-msg-parser-test-"));
    projectsDir = join(tempDir, ".claude", "projects", "test-project");
    mkdirSync(projectsDir, { recursive: true });

    // Mock node:os to return our temp dir as homedir
    mock.module("node:os", () => ({
      homedir: () => tempDir,
      tmpdir,
    }));
  });

  afterEach(() => {
    mock.restore();
    rmSync(tempDir, { recursive: true, force: true });
  });

  test("returns messages for a valid session", async () => {
    const { getClaudeSessionMessages } = await import("./message-parser");

    const sessionId = "session-abc-123";
    writeJsonlFile(sessionId, [
      makeEntry({ type: "user", sessionId, message: { role: "user", content: "Hello" } }),
      makeEntry({ type: "assistant", sessionId, message: { role: "assistant", content: "Hi there" } }),
    ]);

    const result = await getClaudeSessionMessages(sessionId, 0, 50);
    expect(result.messages).toHaveLength(2);
    expect(result.total).toBe(2);
    expect(result.hasMore).toBe(false);
    expect(result.messages[0].content).toBe("Hello");
    expect(result.messages[1].content).toBe("Hi there");
  });

  test("throws when session file is not found", async () => {
    const { getClaudeSessionMessages } = await import("./message-parser");
    expect(getClaudeSessionMessages("nonexistent-session", 0, 50)).rejects.toThrow("Session not found");
  });

  test("filters out non-user/assistant entries", async () => {
    const { getClaudeSessionMessages } = await import("./message-parser");

    const sessionId = "session-filter-test";
    writeJsonlFile(sessionId, [
      { type: "file-history-snapshot", sessionId, timestamp: "2026-01-01T00:00:00Z", message: {} },
      makeEntry({ type: "user", sessionId, message: { role: "user", content: "Question" } }),
      { type: "system", sessionId, timestamp: "2026-01-01T00:00:01Z", message: { role: "system" } },
      makeEntry({ type: "assistant", sessionId, message: { role: "assistant", content: "Answer" } }),
    ]);

    const result = await getClaudeSessionMessages(sessionId, 0, 50);
    expect(result.messages).toHaveLength(2);
    expect(result.total).toBe(2);
    expect(result.messages[0].content).toBe("Question");
    expect(result.messages[1].content).toBe("Answer");
  });

  test("skips malformed JSONL lines", async () => {
    const { getClaudeSessionMessages } = await import("./message-parser");

    const sessionId = "session-malformed";
    const content = [
      JSON.stringify(makeEntry({ type: "user", sessionId, message: { role: "user", content: "Valid" } })),
      "this is not valid json{{{",
      JSON.stringify(
        makeEntry({ type: "assistant", sessionId, message: { role: "assistant", content: "Also valid" } }),
      ),
    ].join("\n");
    writeFileSync(join(projectsDir, `${sessionId}.jsonl`), content);

    const result = await getClaudeSessionMessages(sessionId, 0, 50);
    expect(result.messages).toHaveLength(2);
    expect(result.total).toBe(2);
  });

  test("handles pagination with offset and limit", async () => {
    const { getClaudeSessionMessages } = await import("./message-parser");

    const sessionId = "session-pagination";
    const entries = Array.from({ length: 10 }, (_, i) =>
      makeEntry({
        type: i % 2 === 0 ? "user" : "assistant",
        sessionId,
        message: { role: i % 2 === 0 ? "user" : "assistant", content: `Message ${i}` },
      }),
    );
    writeJsonlFile(sessionId, entries);

    // paginateFromEnd with offset=0, limit=3 returns last 3
    const page1 = await getClaudeSessionMessages(sessionId, 0, 3);
    expect(page1.messages).toHaveLength(3);
    expect(page1.total).toBe(10);
    expect(page1.hasMore).toBe(true);
    expect(page1.messages[0].content).toBe("Message 7");
    expect(page1.messages[2].content).toBe("Message 9");

    // paginateFromEnd with offset=3, limit=3 returns next 3
    const page2 = await getClaudeSessionMessages(sessionId, 3, 3);
    expect(page2.messages).toHaveLength(3);
    expect(page2.hasMore).toBe(true);
    expect(page2.messages[0].content).toBe("Message 4");
    expect(page2.messages[2].content).toBe("Message 6");
  });

  test("handles empty file gracefully", async () => {
    const { getClaudeSessionMessages } = await import("./message-parser");

    const sessionId = "session-empty";
    writeFileSync(join(projectsDir, `${sessionId}.jsonl`), "");

    const result = await getClaudeSessionMessages(sessionId, 0, 50);
    expect(result.messages).toHaveLength(0);
    expect(result.total).toBe(0);
    expect(result.hasMore).toBe(false);
  });

  test("formats tool_use entries correctly through the full pipeline", async () => {
    const { getClaudeSessionMessages } = await import("./message-parser");

    const sessionId = "session-tools";
    writeJsonlFile(sessionId, [
      makeEntry({
        type: "assistant",
        sessionId,
        message: {
          role: "assistant",
          content: [
            { type: "text", text: "Reading file" },
            { type: "tool_use", name: "Read", id: "tool_xyz" },
          ],
        },
      }),
    ]);

    const result = await getClaudeSessionMessages(sessionId, 0, 50);
    expect(result.messages).toHaveLength(1);
    expect(result.messages[0].content).toBe("Reading file");
    expect(result.messages[0].toolUse).toEqual([{ name: "Read", id: "tool_xyz" }]);
  });

  test("hasMore is false when all entries fit within limit", async () => {
    const { getClaudeSessionMessages } = await import("./message-parser");

    const sessionId = "session-no-more";
    writeJsonlFile(sessionId, [
      makeEntry({ type: "user", sessionId, message: { role: "user", content: "One" } }),
      makeEntry({ type: "assistant", sessionId, message: { role: "assistant", content: "Two" } }),
    ]);

    const result = await getClaudeSessionMessages(sessionId, 0, 50);
    expect(result.hasMore).toBe(false);
  });

  test("file with only non-user/assistant entries returns empty messages", async () => {
    const { getClaudeSessionMessages } = await import("./message-parser");

    const sessionId = "session-no-messages";
    writeJsonlFile(sessionId, [
      { type: "system", sessionId, timestamp: "2026-01-01T00:00:00Z", message: { role: "system" } },
      { type: "file-history-snapshot", sessionId, timestamp: "2026-01-01T00:00:01Z", message: {} },
    ]);

    const result = await getClaudeSessionMessages(sessionId, 0, 50);
    expect(result.messages).toHaveLength(0);
    expect(result.total).toBe(0);
  });
});
