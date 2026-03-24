import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import {
  CLAUDE_PROJECTS_DIR,
  type ClaudeJsonlEntry,
  deleteClaudeSessionData,
  discoverClaudeSessions,
  parseClaudeSession,
  pathToProjectDir,
} from "./session-discovery";

// ---------------------------------------------------------------------------
// Factory helpers
// ---------------------------------------------------------------------------

function makeJsonlEntry(overrides: Partial<ClaudeJsonlEntry> = {}): ClaudeJsonlEntry {
  return {
    type: "assistant",
    sessionId: "550e8400-e29b-41d4-a716-446655440000",
    slug: "test-slug",
    cwd: "/home/user/project",
    gitBranch: "main",
    version: "2.1.70",
    timestamp: new Date().toISOString(),
    message: {
      role: "assistant",
      model: "claude-opus-4-6",
      content: [{ type: "text", text: "Hello from Claude." }],
    },
    ...overrides,
  };
}

function toJsonl(entries: Array<Record<string, unknown>>): string {
  return entries.map((e) => JSON.stringify(e)).join("\n");
}

async function writeTempJsonl(dir: string, filename: string, content: string): Promise<string> {
  const filePath = join(dir, filename);
  await writeFile(filePath, content);
  return filePath;
}

// ---------------------------------------------------------------------------
// CLAUDE_PROJECTS_DIR
// ---------------------------------------------------------------------------

describe("CLAUDE_PROJECTS_DIR", () => {
  test("points to ~/.claude/projects", () => {
    expect(CLAUDE_PROJECTS_DIR).toEndWith(join(".claude", "projects"));
    expect(CLAUDE_PROJECTS_DIR).toStartWith("/");
  });
});

// ---------------------------------------------------------------------------
// pathToProjectDir
// ---------------------------------------------------------------------------

describe("pathToProjectDir", () => {
  test("replaces slashes with hyphens", () => {
    expect(pathToProjectDir("/home/user/project")).toBe("-home-user-project");
  });

  test("handles root path", () => {
    expect(pathToProjectDir("/")).toBe("-");
  });

  test("handles deeply nested path", () => {
    expect(pathToProjectDir("/a/b/c/d/e")).toBe("-a-b-c-d-e");
  });

  test("handles path without leading slash", () => {
    // The regex replaces ALL slashes, and the leading hyphen replace is a no-op
    // since there's no leading slash to create a leading hyphen
    expect(pathToProjectDir("home/user/project")).toBe("home-user-project");
  });

  test("handles empty string", () => {
    expect(pathToProjectDir("")).toBe("");
  });

  test("preserves hyphens already in the path", () => {
    expect(pathToProjectDir("/home/user/my-project")).toBe("-home-user-my-project");
  });
});

// ---------------------------------------------------------------------------
// parseClaudeSession
// ---------------------------------------------------------------------------

describe("parseClaudeSession", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(require("node:os").tmpdir(), "agent-town-sd-test-"));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  test("parses a valid JSONL file into SessionInfo", async () => {
    const entry = makeJsonlEntry();
    const filePath = await writeTempJsonl(tempDir, "session.jsonl", toJsonl([entry]));

    const session = await parseClaudeSession(filePath, Date.now());
    expect(session).not.toBeNull();
    expect(session?.sessionId).toBe("550e8400-e29b-41d4-a716-446655440000");
    expect(session?.agentType).toBe("claude-code");
    expect(session?.slug).toBe("test-slug");
    expect(session?.cwd).toBe("/home/user/project");
    expect(session?.projectPath).toBe("/home/user/project");
    expect(session?.projectName).toBe("project");
    expect(session?.gitBranch).toBe("main");
    expect(session?.model).toBe("claude-opus-4-6");
    expect(session?.version).toBe("2.1.70");
  });

  test("returns null for empty file", async () => {
    const filePath = await writeTempJsonl(tempDir, "empty.jsonl", "");

    const session = await parseClaudeSession(filePath, Date.now());
    expect(session).toBeNull();
  });

  test("returns null when all lines are malformed JSON", async () => {
    const filePath = await writeTempJsonl(tempDir, "bad.jsonl", "not json\nalso not json\n{broken");

    const session = await parseClaudeSession(filePath, Date.now());
    expect(session).toBeNull();
  });

  test("returns null when entries lack cwd field", async () => {
    const content = toJsonl([
      { type: "assistant", sessionId: "abc", message: { role: "assistant" }, timestamp: new Date().toISOString() },
    ]);
    const filePath = await writeTempJsonl(tempDir, "no-cwd.jsonl", content);

    const session = await parseClaudeSession(filePath, Date.now());
    expect(session).toBeNull();
  });

  test("skips malformed lines and uses the last valid entry", async () => {
    const validEntry = makeJsonlEntry({ sessionId: "valid-session" });
    const content = `${JSON.stringify(validEntry)}\n{broken json}\nnot json at all`;
    const filePath = await writeTempJsonl(tempDir, "mixed.jsonl", content);

    const session = await parseClaudeSession(filePath, Date.now());
    expect(session).not.toBeNull();
    expect(session?.sessionId).toBe("valid-session");
  });

  test("uses first entry with cwd as projectPath", async () => {
    const entries = [
      makeJsonlEntry({ cwd: "/home/user/root-project" }),
      makeJsonlEntry({ cwd: "/home/user/root-project/subdir" }),
    ];
    const filePath = await writeTempJsonl(tempDir, "multi.jsonl", toJsonl(entries));

    const session = await parseClaudeSession(filePath, Date.now());
    expect(session).not.toBeNull();
    expect(session?.projectPath).toBe("/home/user/root-project");
    expect(session?.cwd).toBe("/home/user/root-project/subdir");
  });

  test("falls back to lastEntry.cwd when early entries lack cwd", async () => {
    const content = toJsonl([
      { type: "file-history-snapshot", messageId: "snap", snapshot: {} },
      makeJsonlEntry({ cwd: "/home/user/fallback" }),
    ]);
    const filePath = await writeTempJsonl(tempDir, "fallback.jsonl", content);

    const session = await parseClaudeSession(filePath, Date.now());
    expect(session).not.toBeNull();
    expect(session?.projectPath).toBe("/home/user/fallback");
  });

  test("uses sessionId prefix as slug when slug is absent", async () => {
    const entry = makeJsonlEntry({ slug: undefined, sessionId: "abcdef12-3456-7890-abcd-ef1234567890" });
    const filePath = await writeTempJsonl(tempDir, "no-slug.jsonl", toJsonl([entry]));

    const session = await parseClaudeSession(filePath, Date.now());
    expect(session).not.toBeNull();
    expect(session?.slug).toBe("abcdef12");
  });

  test("filters out HEAD as git branch", async () => {
    const entry = makeJsonlEntry({ gitBranch: "HEAD" });
    const filePath = await writeTempJsonl(tempDir, "head-branch.jsonl", toJsonl([entry]));

    const session = await parseClaudeSession(filePath, Date.now());
    expect(session).not.toBeNull();
    expect(session?.gitBranch).toBe("");
  });

  test("sets empty gitBranch when gitBranch is undefined", async () => {
    const entry = makeJsonlEntry({ gitBranch: undefined });
    const filePath = await writeTempJsonl(tempDir, "no-branch.jsonl", toJsonl([entry]));

    const session = await parseClaudeSession(filePath, Date.now());
    expect(session).not.toBeNull();
    expect(session?.gitBranch).toBe("");
  });

  test("uses file mtime as lastActivity when entry has no timestamp", async () => {
    const entry = makeJsonlEntry({ timestamp: "" });
    const mtimeMs = Date.now() - 5000;
    const filePath = await writeTempJsonl(tempDir, "no-ts.jsonl", toJsonl([entry]));

    const session = await parseClaudeSession(filePath, mtimeMs);
    expect(session).not.toBeNull();
    expect(session?.lastActivity).toBe(new Date(mtimeMs).toISOString());
  });

  test("uses entry timestamp as lastActivity when present", async () => {
    const ts = "2026-01-15T10:00:00.000Z";
    const entry = makeJsonlEntry({ timestamp: ts });
    const filePath = await writeTempJsonl(tempDir, "with-ts.jsonl", toJsonl([entry]));

    const session = await parseClaudeSession(filePath, Date.now());
    expect(session).not.toBeNull();
    expect(session?.lastActivity).toBe(ts);
  });

  // -- Status detection (detectClaudeStatus) --

  test("detects working status when mtime is less than 30 seconds ago", async () => {
    const entry = makeJsonlEntry();
    const filePath = await writeTempJsonl(tempDir, "working.jsonl", toJsonl([entry]));
    const mtimeMs = Date.now() - 10_000; // 10 seconds ago

    const session = await parseClaudeSession(filePath, mtimeMs);
    expect(session).not.toBeNull();
    expect(session?.status).toBe("working");
  });

  test("detects awaiting_input status when mtime is between 30s and 60s ago", async () => {
    const entry = makeJsonlEntry();
    const filePath = await writeTempJsonl(tempDir, "awaiting.jsonl", toJsonl([entry]));
    const mtimeMs = Date.now() - 45_000; // 45 seconds ago

    const session = await parseClaudeSession(filePath, mtimeMs);
    expect(session).not.toBeNull();
    expect(session?.status).toBe("awaiting_input");
  });

  test("detects idle status when mtime is between 1min and 10min ago", async () => {
    const entry = makeJsonlEntry();
    const filePath = await writeTempJsonl(tempDir, "idle.jsonl", toJsonl([entry]));
    const mtimeMs = Date.now() - 5 * 60 * 1000; // 5 minutes ago

    const session = await parseClaudeSession(filePath, mtimeMs);
    expect(session).not.toBeNull();
    expect(session?.status).toBe("idle");
  });

  test("detects done status when mtime is more than 10 minutes ago", async () => {
    const entry = makeJsonlEntry();
    const filePath = await writeTempJsonl(tempDir, "done.jsonl", toJsonl([entry]));
    const mtimeMs = Date.now() - 15 * 60 * 1000; // 15 minutes ago

    const session = await parseClaudeSession(filePath, mtimeMs);
    expect(session).not.toBeNull();
    expect(session?.status).toBe("done");
  });

  // -- summarizeLastMessage --

  test("summarizes text content from content array", async () => {
    const entry = makeJsonlEntry({
      message: {
        role: "assistant",
        content: [{ type: "text", text: "This is the response text." }],
      },
    });
    const filePath = await writeTempJsonl(tempDir, "text.jsonl", toJsonl([entry]));

    const session = await parseClaudeSession(filePath, Date.now());
    expect(session?.lastMessage).toBe("This is the response text.");
  });

  test("summarizes string content directly", async () => {
    const entry = makeJsonlEntry({
      message: { role: "assistant", content: "Direct string content" },
    });
    const filePath = await writeTempJsonl(tempDir, "str.jsonl", toJsonl([entry]));

    const session = await parseClaudeSession(filePath, Date.now());
    expect(session?.lastMessage).toBe("Direct string content");
  });

  test("truncates long text content to 120 chars", async () => {
    const longText = "A".repeat(200);
    const entry = makeJsonlEntry({
      message: { role: "assistant", content: longText },
    });
    const filePath = await writeTempJsonl(tempDir, "long.jsonl", toJsonl([entry]));

    const session = await parseClaudeSession(filePath, Date.now());
    expect(session?.lastMessage).toHaveLength(120);
  });

  test("summarizes tool_use as [Tool: name]", async () => {
    const entry = makeJsonlEntry({
      message: {
        role: "assistant",
        content: [{ type: "tool_use", name: "Bash", input: {} }],
      },
    });
    const filePath = await writeTempJsonl(tempDir, "tool.jsonl", toJsonl([entry]));

    const session = await parseClaudeSession(filePath, Date.now());
    expect(session?.lastMessage).toBe("[Tool: Bash]");
  });

  test("summarizes tool_result as waiting for response", async () => {
    const entry = makeJsonlEntry({
      message: {
        role: "user",
        content: [{ type: "tool_result", content: "output", tool_use_id: "toolu_123" }],
      },
    });
    const filePath = await writeTempJsonl(tempDir, "tool-result.jsonl", toJsonl([entry]));

    const session = await parseClaudeSession(filePath, Date.now());
    expect(session?.lastMessage).toBe("[Waiting for response...]");
  });

  test("returns empty string for missing content", async () => {
    const entry = makeJsonlEntry({
      message: { role: "assistant" },
    });
    const filePath = await writeTempJsonl(tempDir, "no-content.jsonl", toJsonl([entry]));

    const session = await parseClaudeSession(filePath, Date.now());
    expect(session?.lastMessage).toBe("");
  });

  // -- Token usage aggregation --

  test("aggregates token usage from all entries", async () => {
    const entries = [
      makeJsonlEntry({
        message: {
          role: "assistant",
          model: "claude-opus-4-6",
          content: [{ type: "text", text: "First response." }],
          usage: { input_tokens: 100, output_tokens: 50 },
        },
      }),
      makeJsonlEntry({
        type: "user",
        message: {
          role: "user",
          content: "Follow-up question",
        },
      }),
      makeJsonlEntry({
        message: {
          role: "assistant",
          model: "claude-opus-4-6",
          content: [{ type: "text", text: "Second response." }],
          usage: { input_tokens: 200, output_tokens: 150 },
        },
      }),
    ];
    const filePath = await writeTempJsonl(tempDir, "tokens.jsonl", toJsonl(entries));

    const session = await parseClaudeSession(filePath, Date.now());
    expect(session).not.toBeNull();
    expect(session?.totalInputTokens).toBe(300);
    expect(session?.totalOutputTokens).toBe(200);
    // contextTokens = last entry's input_tokens (no cache fields in test data)
    expect(session?.contextTokens).toBe(200);
  });

  test("contextTokens includes cache tokens from last entry", async () => {
    const entries = [
      makeJsonlEntry({
        message: {
          role: "assistant",
          model: "claude-opus-4-6",
          content: [{ type: "text", text: "Response with cache." }],
          usage: {
            input_tokens: 5,
            output_tokens: 100,
            cache_creation_input_tokens: 200,
            cache_read_input_tokens: 50000,
          },
        },
      }),
    ];
    const filePath = await writeTempJsonl(tempDir, "cache-tokens.jsonl", toJsonl(entries));

    const session = await parseClaudeSession(filePath, Date.now());
    expect(session).not.toBeNull();
    expect(session?.contextTokens).toBe(50205); // 5 + 200 + 50000
    expect(session?.totalInputTokens).toBe(5); // only non-cache input
  });

  test("token totals are undefined when no usage data is present", async () => {
    const entries = [
      makeJsonlEntry({
        message: { role: "assistant", content: "No usage data." },
      }),
    ];
    const filePath = await writeTempJsonl(tempDir, "no-usage.jsonl", toJsonl(entries));

    const session = await parseClaudeSession(filePath, Date.now());
    expect(session).not.toBeNull();
    expect(session?.totalInputTokens).toBeUndefined();
    expect(session?.totalOutputTokens).toBeUndefined();
  });

  test("skips non-numeric usage values during aggregation", async () => {
    const entries = [
      makeJsonlEntry({
        message: {
          role: "assistant",
          model: "claude-opus-4-6",
          content: [{ type: "text", text: "Response." }],
          usage: { input_tokens: 100, output_tokens: "not a number" as unknown as number },
        },
      }),
    ];
    const filePath = await writeTempJsonl(tempDir, "bad-usage.jsonl", toJsonl(entries));

    const session = await parseClaudeSession(filePath, Date.now());
    expect(session).not.toBeNull();
    expect(session?.totalInputTokens).toBe(100);
    expect(session?.totalOutputTokens).toBeUndefined();
  });

  test("returns null for nonexistent file", async () => {
    const session = await parseClaudeSession("/tmp/nonexistent-file.jsonl", Date.now());
    expect(session).toBeNull();
  });

  test("handles file with only whitespace", async () => {
    const filePath = await writeTempJsonl(tempDir, "whitespace.jsonl", "   \n  \n  ");

    const session = await parseClaudeSession(filePath, Date.now());
    expect(session).toBeNull();
  });

  test("reads last valid entry from a long file", async () => {
    // Build a file with many entries, last one has a distinct sessionId
    const entries: Array<Record<string, unknown>> = [];
    for (let i = 0; i < 250; i++) {
      entries.push(makeJsonlEntry({ sessionId: `session-${i}` }));
    }
    entries.push(makeJsonlEntry({ sessionId: "session-final" }));
    const filePath = await writeTempJsonl(tempDir, "long-file.jsonl", toJsonl(entries));

    const session = await parseClaudeSession(filePath, Date.now());
    expect(session).not.toBeNull();
    expect(session?.sessionId).toBe("session-final");
  });

  test("selects last entry scanning from bottom (skips entries without cwd)", async () => {
    const entries = [
      makeJsonlEntry({ sessionId: "first", cwd: "/home/user/project" }),
      {
        type: "assistant",
        sessionId: "no-cwd-entry",
        message: { role: "assistant" },
        timestamp: new Date().toISOString(),
      },
    ];
    const filePath = await writeTempJsonl(tempDir, "bottom-scan.jsonl", toJsonl(entries));

    const session = await parseClaudeSession(filePath, Date.now());
    expect(session).not.toBeNull();
    // Should find "first" because the second entry lacks cwd
    expect(session?.sessionId).toBe("first");
  });

  test("only considers user or assistant type entries for lastEntry", async () => {
    const entries = [
      makeJsonlEntry({ type: "user", cwd: "/home/user/project", sessionId: "user-entry" }),
      {
        type: "system",
        sessionId: "system-entry",
        cwd: "/home/user/project",
        message: { role: "system" },
        timestamp: new Date().toISOString(),
      },
    ];
    const filePath = await writeTempJsonl(tempDir, "type-filter.jsonl", toJsonl(entries));

    const session = await parseClaudeSession(filePath, Date.now());
    expect(session).not.toBeNull();
    // "system" type is not user/assistant, so it falls back to "user-entry"
    expect(session?.sessionId).toBe("user-entry");
  });
});

// ---------------------------------------------------------------------------
// discoverClaudeSessions
// ---------------------------------------------------------------------------

describe("discoverClaudeSessions", () => {
  // discoverClaudeSessions hardcodes CLAUDE_PROJECTS_DIR so we cannot
  // easily redirect it to a temp directory without mocking. Instead, we test
  // that it gracefully handles missing/empty directories and returns an array.

  test("returns an array without throwing (graceful fallback)", async () => {
    const sessions = await discoverClaudeSessions();
    expect(Array.isArray(sessions)).toBe(true);
  });

  test("every returned session has agentType claude-code", async () => {
    const sessions = await discoverClaudeSessions();
    for (const s of sessions) {
      expect(s.agentType).toBe("claude-code");
    }
  });
});

// ---------------------------------------------------------------------------
// deleteClaudeSessionData
// ---------------------------------------------------------------------------

describe("deleteClaudeSessionData", () => {
  // deleteClaudeSessionData also hardcodes CLAUDE_PROJECTS_DIR, so we test
  // that it returns false for a nonexistent session ID without throwing.

  test("returns false for a session ID that does not exist", async () => {
    const result = await deleteClaudeSessionData("nonexistent-session-id-12345");
    expect(result).toBe(false);
  });
});
