import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { getCodexSessionMessages, parseCodexTranscript, searchCodexMessages } from "./message-parser";

const SESSION_ID = "550e8400-e29b-41d4-a716-446655440000";

describe("parseCodexTranscript", () => {
  test("normalizes visible messages, reasoning, tools, models, and usage", () => {
    const transcript = records([
      responseMessage("developer", "private instructions", "2026-09-10T00:00:00.000Z"),
      responseMessage("user", "Please inspect the tree", "2026-09-10T00:00:01.000Z"),
      {
        timestamp: "2026-09-10T00:00:02.000Z",
        type: "response_item",
        payload: { type: "reasoning", summary: [{ type: "summary_text", text: "I should inspect files." }] },
      },
      {
        timestamp: "2026-09-10T00:00:03.000Z",
        type: "response_item",
        payload: { type: "function_call", name: "exec_command", call_id: "call-1", arguments: '{"cmd":"rg"}' },
      },
      {
        timestamp: "2026-09-10T00:00:04.000Z",
        type: "response_item",
        payload: { type: "function_call_output", call_id: "call-1", output: "one.ts" },
      },
      responseMessage("assistant", "The tree is small.", "2026-09-10T00:00:05.000Z", "gpt-5.3-codex"),
      {
        timestamp: "2026-09-10T00:00:06.000Z",
        type: "event_msg",
        payload: {
          type: "token_count",
          info: { total_token_usage: { input_tokens: 120, output_tokens: 30 } },
        },
      },
    ]);

    const messages = parseCodexTranscript(transcript);

    expect(messages).toHaveLength(3);
    expect(messages[0]).toMatchObject({ role: "user", content: "Please inspect the tree" });
    expect(messages[1]).toMatchObject({
      role: "assistant",
      thinking: "I should inspect files.",
      toolUse: [{ name: "exec_command", id: "call-1", input: '{"cmd":"rg"}' }],
      toolResults: [{ toolUseId: "call-1", content: "one.ts" }],
    });
    expect(messages[2]).toMatchObject({
      role: "assistant",
      content: "The tree is small.",
      model: "gpt-5.3-codex",
      tokenUsage: { inputTokens: 120, outputTokens: 30 },
    });
    expect(messages.some((message) => message.content.includes("private"))).toBe(false);
  });

  test("supports legacy event messages and skips malformed or unknown records", () => {
    const transcript = [
      "{bad-json",
      JSON.stringify({ timestamp: "2026-09-10T00:00:00.000Z", type: "unknown", payload: {} }),
      JSON.stringify({
        timestamp: "2026-09-10T00:00:01.000Z",
        type: "event_msg",
        payload: { type: "user_message", message: "Legacy user" },
      }),
      JSON.stringify({
        timestamp: "2026-09-10T00:00:02.000Z",
        type: "event_msg",
        payload: { type: "agent_reasoning", text: "Legacy thought" },
      }),
      JSON.stringify({
        timestamp: "2026-09-10T00:00:03.000Z",
        type: "event_msg",
        payload: { type: "agent_message", message: "Legacy answer" },
      }),
    ].join("\n");

    expect(parseCodexTranscript(transcript)).toEqual([
      expect.objectContaining({ role: "user", content: "Legacy user" }),
      expect.objectContaining({ role: "assistant", content: "", thinking: "Legacy thought" }),
      expect.objectContaining({ role: "assistant", content: "Legacy answer" }),
    ]);
  });
});

describe("Codex transcript access", () => {
  let codexHome: string;

  beforeEach(() => {
    codexHome = mkdtempSync(join(tmpdir(), "codex-messages-"));
    const sessionDir = join(codexHome, "sessions", "2026", "09", "10");
    mkdirSync(sessionDir, { recursive: true });
    writeFileSync(
      join(sessionDir, `rollout-${SESSION_ID}.jsonl`),
      records([
        {
          timestamp: "2026-09-10T00:00:00.000Z",
          type: "session_meta",
          payload: { id: SESSION_ID, cwd: "/work" },
        },
        responseMessage("user", "first question", "2026-09-10T00:00:01.000Z"),
        responseMessage("assistant", "first answer", "2026-09-10T00:00:02.000Z"),
        responseMessage("user", "needle question", "2026-09-10T00:00:03.000Z"),
        responseMessage("assistant", "latest answer", "2026-09-10T00:00:04.000Z"),
      ]),
    );
  });

  afterEach(() => {
    rmSync(codexHome, { recursive: true, force: true });
  });

  test("paginates messages from the end", async () => {
    const response = await getCodexSessionMessages(SESSION_ID, 0, 2, codexHome);
    expect(response).toEqual({
      messages: [
        expect.objectContaining({ content: "needle question" }),
        expect.objectContaining({ content: "latest answer" }),
      ],
      total: 4,
      hasMore: true,
    });
  });

  test("searches only normalized visible transcript content", async () => {
    expect(await searchCodexMessages("needle", 10, codexHome)).toEqual([
      expect.objectContaining({ sessionId: SESSION_ID, agentType: "codex", matchCount: 1 }),
    ]);
    expect(await searchCodexMessages("developer", 10, codexHome)).toEqual([]);
  });
});

function responseMessage(role: string, text: string, timestamp: string, model?: string): Record<string, unknown> {
  return {
    timestamp,
    type: "response_item",
    payload: {
      type: "message",
      role,
      model,
      content: [{ type: role === "assistant" ? "output_text" : "input_text", text }],
    },
  };
}

function records(items: Record<string, unknown>[]): string {
  return items.map((item) => JSON.stringify(item)).join("\n");
}
