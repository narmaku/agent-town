import type { SessionMessage } from "@agent-town/shared";

const TOOL_CONTENT_MAX_LENGTH = 2_000;
const MAX_TREE_DEPTH = 100_000;

export interface TreeSessionHeader {
  id: string;
  cwd: string;
  version?: number;
  timestamp?: string;
  name?: string;
  provider?: string;
  model?: string;
  [key: string]: unknown;
}

export interface ParsedTreeSession {
  header: TreeSessionHeader;
  records: Record<string, unknown>[];
  activeRecords: Record<string, unknown>[];
  messages: SessionMessage[];
}

export function parseTreeSession(text: string): ParsedTreeSession | null {
  const records = text.split("\n").flatMap((line) => {
    const record = parseRecord(line);
    return record ? [record] : [];
  });
  const header = parseHeader(records[0]?.type === "session" ? records[0] : undefined);
  if (!header) return null;

  const messageRecords = records.filter((record) => record.type === "message" && isRecord(record.message));
  const usesTree = header.version !== 1 && messageRecords.some((record) => stringValue(record.id));
  const treeRecords = records.filter((record) => record.type !== "session" && stringValue(record.id));
  const activeRecords = usesTree ? selectActiveBranch(treeRecords) : messageRecords;
  const visibleRecords = usesTree ? applyLatestCompaction(activeRecords) : activeRecords;
  return { header, records, activeRecords, messages: normalizeMessages(visibleRecords) };
}

function parseHeader(record: Record<string, unknown> | undefined): TreeSessionHeader | null {
  if (!record) return null;
  const id = stringValue(record.id);
  const cwd = stringValue(record.cwd);
  if (!id || !cwd) return null;
  return {
    ...record,
    id,
    cwd,
    version: numberValue(record.version) || undefined,
    timestamp: validTimestamp(record.timestamp),
    name: stringValue(record.name) || undefined,
    provider: stringValue(record.provider) || undefined,
    model: stringValue(record.model) || undefined,
  };
}

function selectActiveBranch(records: Record<string, unknown>[]): Record<string, unknown>[] {
  const byId = new Map<string, Record<string, unknown>>();
  const referencedParents = new Set<string>();
  for (const record of records) {
    const id = stringValue(record.id);
    if (id) byId.set(id, record);
    const parentId = stringValue(record.parentId);
    if (parentId) referencedParents.add(parentId);
  }

  const leaf =
    findLastItem(records, (record) => {
      const id = stringValue(record.id);
      return Boolean(id && !referencedParents.has(id));
    }) ?? findLastItem(records, (record) => Boolean(stringValue(record.id)));
  if (!leaf) return records;

  const branch: Record<string, unknown>[] = [];
  const visited = new Set<string>();
  let current: Record<string, unknown> | undefined = leaf;
  while (current && branch.length < MAX_TREE_DEPTH) {
    const id = stringValue(current.id);
    if (!id || visited.has(id)) break;
    visited.add(id);
    branch.push(current);
    const parentId = stringValue(current.parentId);
    current = parentId ? byId.get(parentId) : undefined;
  }
  return branch.reverse();
}

function applyLatestCompaction(records: Record<string, unknown>[]): Record<string, unknown>[] {
  const compactionIndex = findLastIndex(records, (record) => record.type === "compaction");
  if (compactionIndex < 0) return records;

  const compaction = records[compactionIndex];
  const firstKeptEntryId = stringValue(compaction.firstKeptEntryId);
  const firstKeptIndex = records.findIndex(
    (record, index) => index < compactionIndex && stringValue(record.id) === firstKeptEntryId,
  );
  const retained = firstKeptIndex >= 0 ? records.slice(firstKeptIndex, compactionIndex) : [];
  return [compaction, ...retained, ...records.slice(compactionIndex + 1)];
}

function normalizeMessages(records: Record<string, unknown>[]): SessionMessage[] {
  const messages: SessionMessage[] = [];

  for (const record of records) {
    if (record.type === "compaction" || record.type === "branch_summary") {
      const summary = stringValue(record.summary);
      if (summary) {
        messages.push({
          role: "assistant",
          timestamp: normalizeTimestamp(record.timestamp),
          content: summary,
          tokenUsage: normalizeUsage(record.usage),
        });
      }
      continue;
    }

    const rawMessage = isRecord(record.message) ? record.message : undefined;
    if (!rawMessage) continue;
    const role = stringValue(rawMessage.role);
    const timestamp = normalizeTimestamp(record.timestamp ?? rawMessage.timestamp);

    if (role === "user" || role === "assistant") {
      const normalized = normalizeContent(rawMessage.content);
      if (!normalized.text && !normalized.thinking && normalized.toolUse.length === 0) continue;
      messages.push({
        role,
        timestamp,
        content: normalized.text,
        thinking: normalized.thinking || undefined,
        model: stringValue(rawMessage.model) || undefined,
        tokenUsage: normalizeUsage(rawMessage.usage),
        toolUse: normalized.toolUse.length > 0 ? normalized.toolUse : undefined,
      });
      continue;
    }

    if (role === "toolResult" || role === "tool_result") {
      const toolUseId = stringValue(rawMessage.toolCallId) || stringValue(rawMessage.toolUseId);
      const content = normalizeContent(rawMessage.content).text;
      if (!toolUseId || !content) continue;
      const target = findLastItem(messages, (message) =>
        Boolean(message.toolUse?.some((tool) => tool.id === toolUseId)),
      );
      const result = { toolUseId, content: content.slice(0, TOOL_CONTENT_MAX_LENGTH) };
      if (target) {
        target.toolResults ??= [];
        target.toolResults.push(result);
      } else {
        messages.push({ role: "assistant", timestamp, content: "", toolResults: [result] });
      }
    }
  }

  return messages;
}

function normalizeContent(content: unknown): {
  text: string;
  thinking: string;
  toolUse: NonNullable<SessionMessage["toolUse"]>;
} {
  if (typeof content === "string") return { text: content, thinking: "", toolUse: [] };
  if (!Array.isArray(content)) return { text: "", thinking: "", toolUse: [] };

  const text: string[] = [];
  const thinking: string[] = [];
  const toolUse: NonNullable<SessionMessage["toolUse"]> = [];
  for (const block of content) {
    if (!isRecord(block)) continue;
    const type = stringValue(block.type);
    if (type === "text") {
      const value = stringValue(block.text);
      if (value) text.push(value);
    } else if (type === "thinking") {
      const value = stringValue(block.thinking) || stringValue(block.text);
      if (value) thinking.push(value);
    } else if (type === "toolCall" || type === "tool_call" || type === "toolUse") {
      const id = stringValue(block.id);
      const name = stringValue(block.name);
      if (id && name) toolUse.push({ id, name, input: serialize(block.arguments ?? block.input) });
    }
  }
  return { text: text.join("\n\n"), thinking: thinking.join("\n\n"), toolUse };
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

function normalizeUsage(value: unknown): SessionMessage["tokenUsage"] {
  if (!isRecord(value)) return undefined;
  const inputTokens = numberValue(value.input ?? value.inputTokens ?? value.input_tokens);
  const outputTokens = numberValue(value.output ?? value.outputTokens ?? value.output_tokens);
  return inputTokens || outputTokens
    ? { inputTokens: inputTokens || undefined, outputTokens: outputTokens || undefined }
    : undefined;
}

function validTimestamp(value: unknown): string | undefined {
  if (typeof value === "string" && !Number.isNaN(Date.parse(value))) return new Date(value).toISOString();
  if (typeof value === "number" && Number.isFinite(value)) return normalizeTimestamp(value);
  return undefined;
}

function normalizeTimestamp(value: unknown): string {
  return validTimestampWithoutRecursion(value) ?? new Date(0).toISOString();
}

function validTimestampWithoutRecursion(value: unknown): string | undefined {
  if (typeof value === "string" && !Number.isNaN(Date.parse(value))) return new Date(value).toISOString();
  if (typeof value === "number" && Number.isFinite(value)) {
    const milliseconds = value < 10_000_000_000 ? value * 1000 : value;
    return new Date(milliseconds).toISOString();
  }
  return undefined;
}

function serialize(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value === "string") return value.slice(0, TOOL_CONTENT_MAX_LENGTH);
  try {
    return JSON.stringify(value).slice(0, TOOL_CONTENT_MAX_LENGTH);
  } catch (_err) {
    return undefined;
  }
}

function findLastItem<T>(items: T[], predicate: (item: T) => boolean): T | undefined {
  for (let index = items.length - 1; index >= 0; index--) {
    const item = items[index];
    if (predicate(item)) return item;
  }
  return undefined;
}

function findLastIndex<T>(items: T[], predicate: (item: T) => boolean): number {
  for (let index = items.length - 1; index >= 0; index--) {
    const item = items[index];
    if (predicate(item)) return index;
  }
  return -1;
}
