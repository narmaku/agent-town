import { Database } from "bun:sqlite";
import {
  createLogger,
  paginateFromEnd,
  type SessionMessage,
  type SessionMessagesResponse,
  truncateId,
} from "@agent-town/shared";

import type { SearchMessageResult } from "../../session-messages";
import { discoverCodexSessions, findCodexDatabasePaths, findCodexRolloutPath, getCodexHome } from "./session-discovery";

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
  const transcript = await loadCodexTranscript(sessionId, codexHome);
  if (!transcript) {
    log.warn(`session not found: sessionId=${truncateId(sessionId)}`);
    throw new Error("Session not found");
  }

  const messages = parseCodexTranscript(transcript);
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
      const transcript = await loadCodexTranscript(session.sessionId, codexHome);
      if (!transcript) continue;
      const messages = parseCodexTranscript(transcript);
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

async function loadCodexTranscript(sessionId: string, codexHome: string): Promise<string | null> {
  const rolloutPath = await findCodexRolloutPath(sessionId, codexHome);
  if (rolloutPath) return Bun.file(rolloutPath).text();
  return readDatabaseTranscript(sessionId, codexHome);
}

interface HistoryRow {
  payload: unknown;
  timestamp: unknown;
}

async function readDatabaseTranscript(sessionId: string, codexHome: string): Promise<string | null> {
  for (const path of await findCodexDatabasePaths(codexHome)) {
    const records: Record<string, unknown>[] = [];
    let db: Database | undefined;
    try {
      db = new Database(path, { readonly: true, strict: true });
      const tables = db.query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type = 'table'").all();
      for (const { name } of tables) {
        const table = quoteSqlIdentifier(name);
        const columns = db
          .query<{ name: string }, []>(`PRAGMA table_info(${table})`)
          .all()
          .map((column) => column.name);
        const threadColumn = ["thread_id", "session_id"].find((column) => columns.includes(column));
        const payloadColumn = ["item_json", "item", "data", "payload", "json", "items", "content"].find((column) =>
          columns.includes(column),
        );
        if (!threadColumn || !payloadColumn) continue;
        const timestampColumn = ["created_at_ms", "created_at", "timestamp", "ts"].find((column) =>
          columns.includes(column),
        );
        const orderColumn = ["rollout_ordinal", "position", "sequence", "idx", "id", timestampColumn].find(
          (column): column is string => Boolean(column && columns.includes(column)),
        );
        const timestampSelect = timestampColumn ? quoteSqlIdentifier(timestampColumn) : "NULL";
        const orderClause = orderColumn ? ` ORDER BY ${quoteSqlIdentifier(orderColumn)}` : "";
        const rows = db
          .query<HistoryRow, [string]>(
            `SELECT ${quoteSqlIdentifier(payloadColumn)} AS payload, ${timestampSelect} AS timestamp FROM ${table} WHERE ${quoteSqlIdentifier(threadColumn)} = ?${orderClause}`,
          )
          .all(sessionId);
        for (const row of rows) records.push(...historyRowToRecords(row));
      }
    } catch (err) {
      log.debug(`history database skipped: ${formatError(err)}`);
    } finally {
      db?.close();
    }
    if (records.length > 0) return records.map((record) => JSON.stringify(record)).join("\n");
  }
  return null;
}

function historyRowToRecords(row: HistoryRow): Record<string, unknown>[] {
  let value = row.payload;
  if (typeof value === "string") {
    try {
      value = JSON.parse(value) as unknown;
    } catch (_err) {
      return [];
    }
  }
  const values = Array.isArray(value) ? value : isRecord(value) && Array.isArray(value.items) ? value.items : [value];
  return values.flatMap((item) => {
    if (!isRecord(item)) return [];
    if (item.type === "response_item" || item.type === "event_msg") return [item];
    const projectedRecords = currentHistoryItemToRecords(item, row.timestamp);
    if (projectedRecords) return projectedRecords;
    const payload = isRecord(item.item) ? item.item : isRecord(item.payload) ? item.payload : item;
    const payloadType = stringValue(payload.type);
    const eventTypes = new Set(["user_message", "agent_message", "agent_reasoning", "token_count"]);
    return [
      {
        timestamp: item.timestamp ?? row.timestamp,
        type: eventTypes.has(payloadType) ? "event_msg" : "response_item",
        payload,
      },
    ];
  });
}

function currentHistoryItemToRecords(
  item: Record<string, unknown>,
  timestamp: unknown,
): Record<string, unknown>[] | null {
  const type = stringValue(item.type);
  const id = stringValue(item.id);

  if (type === "userMessage" || type === "agentMessage") {
    const text = type === "userMessage" ? extractText(item.content) : stringValue(item.text);
    if (!text) return [];
    return [
      {
        timestamp,
        type: "response_item",
        payload: {
          type: "message",
          role: type === "userMessage" ? "user" : "assistant",
          content: [{ type: type === "userMessage" ? "input_text" : "output_text", text }],
        },
      },
    ];
  }

  if (type === "reasoning") {
    const thinking = extractText(item.summary) || extractText(item.content);
    return thinking
      ? [{ timestamp, type: "response_item", payload: { type: "reasoning", summary: [{ text: thinking }] } }]
      : [];
  }

  const tool = projectedToolItem(item, id);
  if (!tool) return KNOWN_NON_MESSAGE_ITEM_TYPES.has(type) ? [] : null;
  return [
    {
      timestamp,
      type: "response_item",
      payload: { type: "custom_tool_call", call_id: id, name: tool.name, input: tool.input },
    },
    {
      timestamp,
      type: "response_item",
      payload: { type: "custom_tool_call_output", call_id: id, output: tool.output },
    },
  ];
}

const KNOWN_NON_MESSAGE_ITEM_TYPES = new Set(["collabAgentToolCall", "contextCompaction", "subAgentActivity"]);

interface ProjectedToolItem {
  name: string;
  input: unknown;
  output: unknown;
}

function projectedToolItem(item: Record<string, unknown>, id: string): ProjectedToolItem | null {
  if (!id) return null;
  const type = stringValue(item.type);
  if (type === "commandExecution") {
    return { name: type, input: item.command, output: item.aggregatedOutput ?? item.status };
  }
  if (type === "mcpToolCall") {
    const server = stringValue(item.server);
    const tool = stringValue(item.tool);
    return {
      name: [server, tool].filter(Boolean).join(".") || type,
      input: item.arguments,
      output: item.result ?? item.error ?? item.status,
    };
  }
  if (type === "fileChange") {
    return { name: type, input: item.changes, output: item.status };
  }
  if (type === "webSearch") {
    return { name: type, input: item.query ?? item.action, output: item.results };
  }
  return null;
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
      if (typeof item === "string") return item ? [item] : [];
      if (!isRecord(item)) return [];
      const text = stringValue(item.text);
      return text ? [text] : [];
    })
    .join("\n\n");
}

function quoteSqlIdentifier(identifier: string): string {
  return `"${identifier.replaceAll('"', '""')}"`;
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
