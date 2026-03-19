import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseSession } from "./session-parser";

async function createTempJsonl(dir: string, entries: Record<string, unknown>[]): Promise<string> {
  const filePath = join(dir, "test-session.jsonl");
  const content = entries.map((e) => JSON.stringify(e)).join("\n");
  await writeFile(filePath, content);
  return filePath;
}

function makeEntry(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type: "assistant",
    sessionId: "test-session-123",
    slug: "test-slug",
    cwd: "/home/user/project",
    gitBranch: "main",
    version: "2.1.70",
    timestamp: new Date().toISOString(),
    message: {
      role: "assistant",
      model: "claude-opus-4-6",
      content: [{ type: "text", text: "Hello, I can help with that." }],
    },
    ...overrides,
  };
}

describe("session-parser", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "agent-town-test-"));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  test("parses a session from JSONL with assistant text response", async () => {
    const filePath = await createTempJsonl(tempDir, [
      makeEntry({ type: "user", message: { role: "user", content: "hello" } }),
      makeEntry(),
    ]);

    const session = await parseSession(filePath);
    expect(session).not.toBeNull();
    expect(session?.sessionId).toBe("test-session-123");
    expect(session?.slug).toBe("test-slug");
    expect(session?.cwd).toBe("/home/user/project");
    expect(session?.gitBranch).toBe("main");
    expect(session?.lastMessage).toContain("Hello, I can help");
  });

  test("detects working when file was just modified (< 30s)", async () => {
    // Any entry type — if the file was just written, it's working
    const filePath = await createTempJsonl(tempDir, [
      makeEntry({
        type: "assistant",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "What would you like me to do?" }],
        },
      }),
    ]);

    const session = await parseSession(filePath);
    expect(session).not.toBeNull();
    // File was just created so mtime is < 30s ago = working
    expect(session?.status).toBe("working");
  });

  test("detects working when user just sent a message", async () => {
    const filePath = await createTempJsonl(tempDir, [
      makeEntry({
        type: "user",
        message: { role: "user", content: "Please fix the bug" },
      }),
    ]);

    const session = await parseSession(filePath);
    expect(session).not.toBeNull();
    expect(session?.status).toBe("working");
  });

  test("detects working when tool_result just arrived", async () => {
    const filePath = await createTempJsonl(tempDir, [
      makeEntry({
        type: "user",
        message: {
          role: "user",
          content: [
            {
              type: "tool_result",
              content: "file contents here",
              tool_use_id: "toolu_123",
            },
          ],
        },
      }),
    ]);

    const session = await parseSession(filePath);
    expect(session).not.toBeNull();
    expect(session?.status).toBe("working");
  });

  test("summarizes tool_use as [Tool: name]", async () => {
    const filePath = await createTempJsonl(tempDir, [
      makeEntry({
        type: "assistant",
        message: {
          role: "assistant",
          content: [{ type: "tool_use", name: "Read", input: {} }],
        },
      }),
    ]);

    const session = await parseSession(filePath);
    expect(session).not.toBeNull();
    expect(session?.lastMessage).toBe("[Tool: Read]");
  });

  test("returns null for invalid JSONL", async () => {
    const filePath = join(tempDir, "bad.jsonl");
    await writeFile(filePath, "not json at all\n");

    const session = await parseSession(filePath);
    expect(session).toBeNull();
  });

  test("returns null for empty file", async () => {
    const filePath = join(tempDir, "empty.jsonl");
    await writeFile(filePath, "");

    const session = await parseSession(filePath);
    expect(session).toBeNull();
  });

  test("extracts model from message", async () => {
    const filePath = await createTempJsonl(tempDir, [
      makeEntry({
        message: {
          role: "assistant",
          model: "claude-opus-4-6",
          content: [{ type: "text", text: "test" }],
        },
      }),
    ]);

    const session = await parseSession(filePath);
    expect(session).not.toBeNull();
    expect(session?.model).toBe("claude-opus-4-6");
  });

  test("derives project name from cwd (handles hyphenated names)", async () => {
    const filePath = await createTempJsonl(tempDir, [
      makeEntry({ cwd: "/tmp/development/rubric-kit" }),
      makeEntry({ cwd: "/tmp/development/rubric-kit" }),
    ]);

    const session = await parseSession(filePath);
    expect(session).not.toBeNull();
    expect(session?.projectName).toBe("rubric-kit");
    expect(session?.projectPath).toBe("/tmp/development/rubric-kit");
  });

  test("derives project name from cwd for nested paths", async () => {
    const filePath = await createTempJsonl(tempDir, [makeEntry({ cwd: "/tmp/development/rls-unified-test-suite" })]);

    const session = await parseSession(filePath);
    expect(session).not.toBeNull();
    expect(session?.projectName).toBe("rls-unified-test-suite");
  });

  test("filters out HEAD as git branch", async () => {
    const filePath = await createTempJsonl(tempDir, [makeEntry({ gitBranch: "HEAD" })]);

    const session = await parseSession(filePath);
    expect(session).not.toBeNull();
    expect(session?.gitBranch).toBe("");
  });

  test("uses first entry with cwd as projectPath, not last entry cwd", async () => {
    // Simulates: first line is file-history-snapshot (no cwd),
    // then initial entry in project root, then later entry in subdirectory
    const filePath = await createTempJsonl(tempDir, [
      { type: "file-history-snapshot", messageId: "abc", snapshot: {} },
      makeEntry({ cwd: "/home/user/my-project" }),
      makeEntry({ cwd: "/home/user/my-project/subdir" }),
    ]);

    const session = await parseSession(filePath);
    expect(session).not.toBeNull();
    expect(session?.projectPath).toBe("/home/user/my-project");
    expect(session?.projectName).toBe("my-project");
    // cwd should reflect the LATEST working directory
    expect(session?.cwd).toBe("/home/user/my-project/subdir");
  });

  test("falls back to lastEntry.cwd if no entry has cwd", async () => {
    // Edge case: all entries lack cwd except the last one
    const filePath = await createTempJsonl(tempDir, [
      { type: "file-history-snapshot", messageId: "abc", snapshot: {} },
      makeEntry({ cwd: "/home/user/fallback-project" }),
    ]);

    const session = await parseSession(filePath);
    expect(session).not.toBeNull();
    expect(session?.projectPath).toBe("/home/user/fallback-project");
  });
});
