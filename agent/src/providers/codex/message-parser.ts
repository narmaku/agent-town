import {
  createLogger,
  paginateFromEnd,
  type SessionMessage,
  type SessionMessagesResponse,
  truncateId,
} from "@agent-town/shared";

import type { SearchMessageResult } from "../../session-messages";
import { discoverCodexSessions, findCodexRolloutPath, getCodexHome } from "./session-discovery";

const log = createLogger("codex:messages");

const TOOL_CONTENT_MAX_LENGTH = 2_000;
const SEARCH_SNIPPET_LENGTH = 120;

export function parseCodexTranscript(text: string): SessionMessage[] {
  const messages: SessionMessage[] = [];
  let pendingToolMessage: SessionMessage | undefined;

  const flushPendingToolMessage = (): void => {
    if (!pendingToolMessage) return;
    messages.push(pendingToolMessage);
    pendingToolMessage = undefined;
  };

  for (const line of text.split("\n")) {
    const record = parseRecord(line);
    if (!record) continue;
    const payload = isRecord(record.payload) ? record.payload : undefined;
    if (!payload) continue;
    const timestamp = normalizeTimestamp(record.timestamp);
    const payloadType = stringValue(payload.type);

    if (record.type === "response_item" && payloadType === "message") {
      const role = stringValue(payload.role);
      if (role !== "user" && role !== "assistant") continue;
      flushPendingToolMessage();
      const content = extractText(payload.content);
      if (!content) continue;
      messages.push({
        role,
        timestamp,
        content,
        model: stringValue(payload.model) || undefined,
      });
      continue;
    }

    if (record.type === "response_item" && payloadType === "reasoning") {
      const thinking = extractText(payload.summary) || extractText(payload.content);
      if (!thinking) continue;
      pendingToolMessage ??= { role: "assistant", timestamp, content: "" };
      pendingToolMessage.thinking = [pendingToolMessage.thinking, thinking].filter(Boolean).join("\n\n");
      continue;
    }

    if (record.type === "response_item" && (payloadType === "function_call" || payloadType === "custom_tool_call")) {
      const id = stringValue(payload.call_id) || stringValue(payload.id);
      const name = stringValue(payload.name);
      if (!id || !name) continue;
      pendingToolMessage ??= { role: "assistant", timestamp, content: "" };
      pendingToolMessage.toolUse ??= [];
      pendingToolMessage.toolUse.push({
        name,
        id,
        input: serializeToolInput(payload.arguments ?? payload.input),
      });
      continue;
    }

    if (
      record.type === "response_item" &&
      (payloadType === "function_call_output" || payloadType === "custom_tool_call_output")
    ) {
      const toolUseId = stringValue(payload.call_id) || stringValue(payload.id);
      const output = serializeToolOutput(payload.output);
      if (!toolUseId || !output) continue;
      pendingToolMessage ??= { role: "assistant", timestamp, content: "" };
      pendingToolMessage.toolResults ??= [];
      pendingToolMessage.toolResults.push({ toolUseId, content: output });
      continue;
    }

    if (record.type !== "event_msg") continue;

    if (payloadType === "user_message" || payloadType === "agent_message") {
      flushPendingToolMessage();
      const content = stringValue(payload.message) || extractText(payload.content);
      if (!content) continue;
      messages.push({
        role: payloadType === "user_message" ? "user" : "assistant",
        timestamp,
        content,
        model: stringValue(payload.model) || undefined,
      });
      continue;
    }

    if (payloadType === "agent_reasoning") {
      flushPendingToolMessage();
      const thinking = stringValue(payload.text) || stringValue(payload.message) || extractText(payload.content);
      if (thinking) messages.push({ role: "assistant", timestamp, content: "", thinking });
      continue;
    }

    if (payloadType === "token_count") {
      const info = isRecord(payload.info) ? payload.info : undefined;
      const totalUsage = info && isRecord(info.total_token_usage) ? info.total_token_usage : info;
      const previous = pendingToolMessage ?? messages.at(-1);
      if (!previous || previous.role !== "assistant" || !totalUsage) continue;
      const inputTokens = numberValue(totalUsage.input_tokens);
      const outputTokens = numberValue(totalUsage.output_tokens);
      if (inputTokens || outputTokens) {
        previous.tokenUsage = {
          inputTokens: inputTokens || undefined,
          outputTokens: outputTokens || undefined,
        };
      }
    }
  }

  flushPendingToolMessage();
  return messages;
}

export async function getCodexSessionMessages(
  sessionId: string,
  offset: number,
  limit: number,
  codexHome = getCodexHome(),
): Promise<SessionMessagesResponse> {
  const path = await findCodexRolloutPath(sessionId, codexHome);
  if (!path) {
    log.warn(`session not found: sessionId=${truncateId(sessionId)}`);
    throw new Error("Session not found");
  }

  const messages = parseCodexTranscript(await Bun.file(path).text());
  const { slice, hasMore } = paginateFromEnd(messages, offset, limit);
  return { messages: slice, total: messages.length, hasMore };
}

export async function searchCodexMessages(
  query: string,
  maxResults: number,
  codexHome = getCodexHome(),
): Promise<SearchMessageResult[]> {
  if (maxResults <= 0) return [];
  const normalizedQuery = query.toLowerCase();
  const sessions = await discoverCodexSessions({ codexHome });
  const results: SearchMessageResult[] = [];

  for (const session of sessions) {
    if (results.length >= maxResults) break;
    try {
      const path = await findCodexRolloutPath(session.sessionId, codexHome);
      if (!path) continue;
      const messages = parseCodexTranscript(await Bun.file(path).text());
      let matchCount = 0;
      let snippet = "";
      for (const message of messages) {
        for (const content of [message.content, message.thinking ?? ""]) {
          const index = content.toLowerCase().indexOf(normalizedQuery);
          if (index < 0) continue;
          matchCount++;
          if (!snippet) snippet = extractSnippet(content, index, normalizedQuery.length);
        }
      }
      if (matchCount > 0) results.push({ sessionId: session.sessionId, agentType: "codex", snippet, matchCount });
    } catch (err) {
      log.debug(`search skipped session=${truncateId(session.sessionId)}: ${formatError(err)}`);
    }
  }

  return results;
}

function parseRecord(line: string): Record<string, unknown> | undefined {
  if (!line.trim()) return undefined;
  try {
    const value: unknown = JSON.parse(line);
    return isRecord(value) ? value : undefined;
  } catch (_err) {
    return undefined;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function numberValue(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function normalizeTimestamp(value: unknown): string {
  if (typeof value === "string" && !Number.isNaN(Date.parse(value))) return new Date(value).toISOString();
  if (typeof value === "number" && Number.isFinite(value)) {
    const milliseconds = value < 10_000_000_000 ? value * 1000 : value;
    return new Date(milliseconds).toISOString();
  }
  return new Date(0).toISOString();
}

function extractText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .flatMap((item) => {
      if (!isRecord(item)) return [];
      const text = stringValue(item.text);
      return text ? [text] : [];
    })
    .join("\n\n");
}

function serializeToolInput(value: unknown): string | undefined {
  if (typeof value === "string") return value.slice(0, TOOL_CONTENT_MAX_LENGTH);
  if (value === undefined) return undefined;
  try {
    return JSON.stringify(value, null, 2).slice(0, TOOL_CONTENT_MAX_LENGTH);
  } catch (_err) {
    return undefined;
  }
}

function serializeToolOutput(value: unknown): string {
  if (typeof value === "string") return value.slice(0, TOOL_CONTENT_MAX_LENGTH);
  if (value === undefined) return "";
  try {
    return JSON.stringify(value, null, 2).slice(0, TOOL_CONTENT_MAX_LENGTH);
  } catch (_err) {
    return "[tool output]";
  }
}

function extractSnippet(content: string, index: number, queryLength: number): string {
  const half = Math.floor((SEARCH_SNIPPET_LENGTH - queryLength) / 2);
  const start = Math.max(0, index - half);
  const end = Math.min(content.length, index + queryLength + half);
  return `${start > 0 ? "…" : ""}${content.slice(start, end)}${end < content.length ? "…" : ""}`;
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
