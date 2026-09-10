import { describe, expect, test } from "bun:test";

import { parseTreeSession } from "./tree-session";

function jsonl(records: unknown[]): string {
  return records.map((record) => JSON.stringify(record)).join("\n");
}

describe("parseTreeSession", () => {
  test("selects only the ancestry of the last valid tree leaf", () => {
    const parsed = parseTreeSession(
      jsonl([
        { type: "session", version: 3, id: "session-1", cwd: "/work", timestamp: "2026-09-10T00:00:00Z" },
        {
          type: "message",
          id: "root",
          parentId: null,
          timestamp: "2026-09-10T00:00:01Z",
          message: { role: "user", content: "start" },
        },
        {
          type: "message",
          id: "abandoned",
          parentId: "root",
          timestamp: "2026-09-10T00:00:02Z",
          message: { role: "assistant", content: [{ type: "text", text: "wrong branch" }] },
        },
        {
          type: "message",
          id: "chosen",
          parentId: "root",
          timestamp: "2026-09-10T00:00:03Z",
          message: { role: "assistant", content: [{ type: "text", text: "right branch" }] },
        },
      ]),
    );

    expect(parsed?.messages.map((message) => message.content)).toEqual(["start", "right branch"]);
  });

  test("normalizes thinking, camel-case tool calls, results, model, timestamps, and usage", () => {
    const parsed = parseTreeSession(
      jsonl([
        { type: "session", version: 3, id: "session-1", cwd: "/work", timestamp: 1_700_000_000 },
        {
          type: "message",
          id: "assistant",
          parentId: null,
          timestamp: 1_700_000_001,
          message: {
            role: "assistant",
            model: "pi-model",
            content: [
              { type: "thinking", thinking: "considering" },
              { type: "text", text: "I will inspect it." },
              { type: "toolCall", id: "tool-1", name: "read", arguments: { path: "README.md" } },
            ],
            usage: { input: 12, output: 5 },
          },
        },
        {
          type: "message",
          id: "tool-result",
          parentId: "assistant",
          timestamp: 1_700_000_002_000,
          message: {
            role: "toolResult",
            toolCallId: "tool-1",
            content: [{ type: "text", text: "contents" }],
          },
        },
      ]),
    );

    expect(parsed?.messages).toEqual([
      {
        role: "assistant",
        timestamp: "2023-11-14T22:13:21.000Z",
        content: "I will inspect it.",
        thinking: "considering",
        model: "pi-model",
        tokenUsage: { inputTokens: 12, outputTokens: 5 },
        toolUse: [{ id: "tool-1", name: "read", input: '{"path":"README.md"}' }],
        toolResults: [{ toolUseId: "tool-1", content: "contents" }],
      },
    ]);
  });

  test("uses safe linear history for v1 records without tree IDs", () => {
    const parsed = parseTreeSession(
      `${jsonl([
        { type: "session", version: 1, id: "legacy", cwd: "/work", timestamp: "invalid" },
        { type: "message", timestamp: "2026-09-10T00:00:01Z", message: { role: "user", content: "hello" } },
        { type: "message", timestamp: "2026-09-10T00:00:02Z", message: { role: "assistant", content: "hi" } },
      ])}\n{bad json}\n`,
    );

    expect(parsed?.messages.map((message) => message.content)).toEqual(["hello", "hi"]);
  });

  test("guards dangling parents and cycles without hanging", () => {
    const dangling = parseTreeSession(
      jsonl([
        { type: "session", version: 3, id: "dangling", cwd: "/work" },
        { type: "message", id: "leaf", parentId: "missing", message: { role: "user", content: "kept" } },
      ]),
    );
    const cyclic = parseTreeSession(
      jsonl([
        { type: "session", version: 3, id: "cyclic", cwd: "/work" },
        { type: "message", id: "a", parentId: "b", message: { role: "user", content: "a" } },
        { type: "message", id: "b", parentId: "a", message: { role: "assistant", content: "b" } },
      ]),
    );

    expect(dangling?.messages.map((message) => message.content)).toEqual(["kept"]);
    expect(cyclic?.messages.length).toBeGreaterThan(0);
    expect(cyclic?.messages.length).toBeLessThanOrEqual(2);
  });

  test("rejects files without a valid logical session header", () => {
    expect(parseTreeSession(jsonl([{ type: "message", message: { role: "user", content: "no header" } }]))).toBeNull();
    expect(parseTreeSession(jsonl([{ type: "session", id: "", cwd: "/work" }]))).toBeNull();
    expect(parseTreeSession("\n{malformed}\n")).toBeNull();
  });
});
