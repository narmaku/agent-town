import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { searchClaudeMessages } from "./claude-code/message-parser";
import { searchGeminiMessages } from "./gemini-cli/message-parser";
import { searchOpenCodeMessages } from "./opencode/message-parser";
import { contentText, extractSnippet, matchTexts } from "./search";

describe("search helpers", () => {
  test("contentText joins text blocks and ignores the rest", () => {
    expect(contentText("plain")).toBe("plain");
    expect(contentText([{ type: "text", text: "a" }, { type: "tool_use" }, { text: "b" }])).toBe("a b");
    expect(contentText({ text: "not an array" })).toBe("");
  });

  test("matchTexts counts matching texts and snippets the first", () => {
    expect(matchTexts(["no", "Find ME here", "find me again"], "find me")).toEqual({
      matchCount: 2,
      snippet: "Find ME here",
    });
  });

  test("extractSnippet keeps a single line around the match", () => {
    const text = `${"x".repeat(200)}\nneedle\n${"y".repeat(200)}`;
    const snippet = extractSnippet(text, text.indexOf("needle"), 6);
    expect(snippet.startsWith("…")).toBe(true);
    expect(snippet.endsWith("…")).toBe(true);
    expect(snippet).toContain(" needle ");
    expect(snippet).not.toContain("\n");
  });
});

describe("provider message search", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "agent-town-search-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test("Claude Code: finds sessions in JSONL transcripts", async () => {
    const project = join(dir, "-work-app");
    mkdirSync(project);
    const lines = [
      { sessionId: "claude-1", type: "summary" },
      { sessionId: "claude-1", message: { content: "please fix the Flaky test" } },
      { sessionId: "claude-1", message: { content: [{ type: "text", text: "the flaky test is fixed" }] } },
    ];
    writeFileSync(join(project, "claude-1.jsonl"), lines.map((line) => JSON.stringify(line)).join("\n"));
    writeFileSync(join(project, "other.jsonl"), JSON.stringify({ sessionId: "claude-2", message: { content: "hi" } }));

    expect(await searchClaudeMessages("flaky test", 10, dir)).toEqual([
      { sessionId: "claude-1", agentType: "claude-code", snippet: "please fix the Flaky test", matchCount: 2 },
    ]);
    expect(await searchClaudeMessages("flaky test", 10, join(dir, "missing"))).toEqual([]);
  });

  test("Gemini CLI: finds sessions in chat files", async () => {
    const chats = join(dir, "hash1", "chats");
    mkdirSync(chats, { recursive: true });
    writeFileSync(
      join(chats, "session-1.json"),
      JSON.stringify({ sessionId: "gem-1", messages: [{ content: "deploy to staging" }, { content: "ok" }] }),
    );

    expect(await searchGeminiMessages("staging", 10, dir)).toEqual([
      { sessionId: "gem-1", agentType: "gemini-cli", snippet: "deploy to staging", matchCount: 1 },
    ]);
  });

  test("OpenCode: finds sessions in the SQLite database", async () => {
    const dbPath = join(dir, "opencode.db");
    const db = new Database(dbPath);
    db.run("CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT NOT NULL)");
    db.run("CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT NOT NULL, data TEXT NOT NULL)");
    db.run("INSERT INTO message VALUES ('m1', 'ses_1'), ('m2', 'ses_2')");
    db.run("INSERT INTO part VALUES ('p1', 'm1', ?), ('p2', 'm2', ?)", [
      JSON.stringify({ type: "text", text: "Rotate the API keys" }),
      JSON.stringify({ type: "text", text: "unrelated" }),
    ]);
    db.close();

    expect(await searchOpenCodeMessages("api keys", 10, dbPath)).toEqual([
      { sessionId: "ses_1", agentType: "opencode", snippet: "Rotate the API keys", matchCount: 1 },
    ]);
  });
});
