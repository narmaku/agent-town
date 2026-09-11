import { describe, expect, test } from "bun:test";

import { parseOmpSession, serializeOmpTitleSlotForTest } from "./session-parser";

function jsonl(records: Record<string, unknown>[]): string {
  return records.map((record) => JSON.stringify(record)).join("\n");
}

describe("OMP session parsing", () => {
  test("parses the fixed 256-byte title slot before a current session header", () => {
    const slot = serializeOmpTitleSlotForTest("Current OMP title");
    expect(new TextEncoder().encode(slot).byteLength).toBe(256);

    const parsed = parseOmpSession(
      `${slot}${jsonl([
        {
          type: "session",
          version: 3,
          id: "0199a8d7-9d84-7000-a123-123456789abc",
          cwd: "/work/omp",
          title: "stale header title",
          timestamp: "2026-09-10T00:00:00Z",
        },
        {
          type: "message",
          id: "user",
          parentId: null,
          timestamp: "2026-09-10T00:00:01Z",
          message: { role: "user", content: "hello" },
        },
      ])}`,
    );

    expect(parsed?.title).toBe("Current OMP title");
    expect(parsed?.header.id).toBe("0199a8d7-9d84-7000-a123-123456789abc");
    expect(parsed?.header.cwd).toBe("/work/omp");
    expect(parsed?.title).not.toContain("pad");
  });

  test("strips a byte-sized title slot without corrupting a header after a multibyte title", () => {
    const slot = serializeOmpTitleSlotForTest("設計を直す");
    expect(new TextEncoder().encode(slot).byteLength).toBe(256);
    expect(slot.length).toBeLessThan(256);

    const parsed = parseOmpSession(
      `${slot}${JSON.stringify({
        type: "session",
        version: 3,
        id: "unicode-title",
        cwd: "/work/unicode",
      })}`,
    );

    expect(parsed?.header.id).toBe("unicode-title");
    expect(parsed?.title).toBe("設計を直す");
  });

  test("accepts legacy header-first sessions and applies title fallbacks", () => {
    const headerTitle = parseOmpSession(
      jsonl([
        { type: "session", version: 1, id: "legacy.a-7", cwd: "/work/legacy", title: "Header title" },
        { type: "message", message: { role: "user", content: "legacy" } },
      ]),
    );
    expect(headerTitle?.title).toBe("Header title");

    const compactionTitle = parseOmpSession(
      jsonl([
        { type: "session", version: 3, id: "compact-id", cwd: "/work/compact" },
        {
          type: "compaction",
          id: "compact",
          parentId: null,
          summary: "Long summary",
          shortSummary: "Compaction title",
        },
      ]),
    );
    expect(compactionTitle?.title).toBe("Compaction title");

    const fallback = parseOmpSession(
      jsonl([{ type: "session", version: 1, id: "opaque-fallback", cwd: "/work/fallback" }]),
    );
    expect(fallback?.title).toBe("opaque-fallback");
  });

  test("emits only the active branch after its latest reset boundary", () => {
    const parsed = parseOmpSession(
      jsonl([
        { type: "session", version: 3, id: "tree-id", cwd: "/work/tree" },
        {
          type: "message",
          id: "root",
          parentId: null,
          message: { role: "user", content: "pre reset" },
        },
        {
          type: "message",
          id: "abandoned",
          parentId: "root",
          message: { role: "assistant", content: "abandoned branch" },
        },
        { type: "reset_boundary", id: "reset", parentId: "root" },
        {
          type: "message",
          id: "active",
          parentId: "reset",
          message: { role: "user", content: "active prompt" },
        },
        {
          type: "message",
          id: "answer",
          parentId: "active",
          message: {
            role: "assistant",
            model: "openai/gpt-5.2",
            content: [
              { type: "thinking", thinking: "private chain" },
              { type: "text", text: "active answer" },
              { type: "toolCall", id: "call-1", name: "read", arguments: { path: "README.md" } },
            ],
            usage: { input: 14, output: 8 },
          },
        },
        {
          type: "message",
          id: "result",
          parentId: "answer",
          message: { role: "toolResult", toolCallId: "call-1", content: [{ type: "text", text: "contents" }] },
        },
        {
          type: "credential_pin",
          id: "secret",
          parentId: "result",
          provider: "openai",
          hash: "must-not-render",
        },
      ]),
    );

    expect(parsed?.messages.map((message) => message.content)).toEqual(["active prompt", "active answer"]);
    expect(parsed?.messages[1]).toMatchObject({
      thinking: "private chain",
      model: "openai/gpt-5.2",
      tokenUsage: { inputTokens: 14, outputTokens: 8 },
      toolUse: [{ id: "call-1", name: "read", input: '{"path":"README.md"}' }],
      toolResults: [{ toolUseId: "call-1", content: "contents" }],
    });
    expect(JSON.stringify(parsed?.messages)).not.toContain("must-not-render");
  });

  test("applies compaction within the post-reset branch", () => {
    const parsed = parseOmpSession(
      jsonl([
        { type: "session", version: 3, id: "reset-compacted", cwd: "/work/tree" },
        {
          type: "message",
          id: "old",
          parentId: null,
          message: { role: "user", content: "discarded before reset" },
        },
        { type: "reset_boundary", id: "reset", parentId: "old" },
        {
          type: "message",
          id: "kept",
          parentId: "reset",
          message: { role: "user", content: "retained after reset" },
        },
        {
          type: "compaction",
          id: "compact",
          parentId: "kept",
          summary: "Post-reset summary",
          firstKeptEntryId: "kept",
        },
        {
          type: "message",
          id: "after",
          parentId: "compact",
          message: { role: "assistant", content: "continued after compaction" },
        },
      ]),
    );

    expect(parsed?.messages.map((message) => message.content)).toEqual([
      "Post-reset summary",
      "retained after reset",
      "continued after compaction",
    ]);
  });

  test("derives lifecycle status without exposing lifecycle records as chat", () => {
    const normal = parseOmpSession(
      jsonl([
        { type: "session", version: 3, id: "normal", cwd: "/work" },
        { type: "custom", id: "exit", parentId: null, customType: "session_exit", data: { kind: "normal" } },
      ]),
    );
    const fatal = parseOmpSession(
      jsonl([
        { type: "session", version: 3, id: "fatal", cwd: "/work" },
        { type: "session_exit", id: "exit", parentId: null, kind: "fatal", reason: "provider failed" },
      ]),
    );
    const pending = parseOmpSession(
      jsonl([
        { type: "session", version: 3, id: "pending", cwd: "/work" },
        {
          type: "session_exit",
          id: "exit",
          parentId: null,
          kind: "process_exit",
          pendingToolCalls: [{ toolName: "bash" }],
        },
      ]),
    );

    expect(normal?.lifecycleStatus).toBe("done");
    expect(fatal?.lifecycleStatus).toBe("error");
    expect(pending?.lifecycleStatus).toBe("working");
    expect(normal?.messages).toEqual([]);
  });

  test("derives lifecycle status from current raw exit records without tree fields", () => {
    const parsed = parseOmpSession(
      jsonl([
        { type: "session", version: 3, id: "raw-exit", cwd: "/work" },
        {
          type: "message",
          id: "answer",
          parentId: null,
          message: { role: "assistant", content: "completed before the crash" },
        },
        {
          type: "custom",
          customType: "session_exit",
          data: { reason: "uncaught_exception", kind: "fatal", recordedAt: "2026-09-10T00:00:00Z" },
        },
      ]),
    );

    expect(parsed?.lifecycleStatus).toBe("error");
    expect(parsed?.messages.map((message) => message.content)).toEqual(["completed before the crash"]);
  });

  test("maps message completion, error, abort, and pending states", () => {
    function withMessage(message: Record<string, unknown>) {
      return parseOmpSession(
        jsonl([
          { type: "session", version: 3, id: "status", cwd: "/work" },
          { type: "message", id: "message", parentId: null, message },
        ]),
      )?.lifecycleStatus;
    }

    expect(withMessage({ role: "assistant", content: "done" })).toBe("done");
    expect(withMessage({ role: "assistant", stopReason: "error", content: "failed" })).toBe("error");
    expect(withMessage({ role: "assistant", stopReason: "aborted", content: "stopped" })).toBe("exited");
    expect(withMessage({ role: "assistant", content: [{ type: "toolCall", id: "a", name: "bash" }] })).toBe("working");
    expect(withMessage({ role: "user", content: "waiting" })).toBe("working");
  });
});
