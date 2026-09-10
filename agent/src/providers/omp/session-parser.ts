import type { SessionStatus } from "@agent-town/shared";

import { type ParsedTreeSession, parseTreeSession } from "../tree-session";

const TITLE_SLOT_BYTES = 256;

export interface ParsedOmpSession extends ParsedTreeSession {
  title: string;
  lifecycleStatus?: SessionStatus;
}

export function parseOmpSession(text: string): ParsedOmpSession | null {
  const slot = parseTitleSlot(text);
  const logicalText = slot ? text.slice(slot.byteLength) : text;
  const parsed = parseTreeSession(logicalText, { resetBoundaryType: "reset_boundary" });
  if (!parsed) return null;

  return {
    ...parsed,
    title: resolveTitle(slot?.title, parsed),
    lifecycleStatus: deriveLifecycleStatus(parsed.activeRecords.length > 0 ? parsed.activeRecords : parsed.records),
  };
}

export function serializeOmpTitleSlotForTest(title: string): string {
  const base = {
    type: "title",
    v: 1,
    title,
    updatedAt: "2026-09-10T00:00:00.000Z",
    pad: "",
  };
  const unpadded = `${JSON.stringify(base)}\n`;
  const paddingLength = TITLE_SLOT_BYTES - new TextEncoder().encode(unpadded).byteLength;
  if (paddingLength < 0) throw new Error("OMP title is too long for a title slot fixture");
  return `${JSON.stringify({ ...base, pad: " ".repeat(paddingLength) })}\n`;
}

function parseTitleSlot(text: string): { title: string; byteLength: number } | undefined {
  const newlineIndex = text.indexOf("\n");
  if (newlineIndex < 0) return undefined;
  const physicalLine = text.slice(0, newlineIndex + 1);
  const byteLength = new TextEncoder().encode(physicalLine).byteLength;
  if (byteLength !== TITLE_SLOT_BYTES) return undefined;

  try {
    const value: unknown = JSON.parse(physicalLine);
    if (!isRecord(value) || value.type !== "title" || value.v !== 1) return undefined;
    if (typeof value.title !== "string" || typeof value.updatedAt !== "string" || typeof value.pad !== "string") {
      return undefined;
    }
    return { title: value.title.trim(), byteLength };
  } catch (_err) {
    return undefined;
  }
}

function resolveTitle(slotTitle: string | undefined, parsed: ParsedTreeSession): string {
  if (slotTitle) return slotTitle;
  const headerTitle = stringValue(parsed.header.title) || parsed.header.name;
  if (headerTitle) return headerTitle;

  for (let index = parsed.records.length - 1; index >= 0; index--) {
    const record = parsed.records[index];
    if (record.type !== "compaction") continue;
    const shortSummary = stringValue(record.shortSummary);
    if (shortSummary) return shortSummary;
  }
  return parsed.header.id;
}

function deriveLifecycleStatus(records: Record<string, unknown>[]): SessionStatus | undefined {
  for (let index = records.length - 1; index >= 0; index--) {
    const record = records[index];
    const exit = sessionExitData(record);
    if (exit) return statusFromExit(exit);

    if (record.type !== "message" || !isRecord(record.message)) continue;
    return statusFromMessage(record.message);
  }
  return undefined;
}

function sessionExitData(record: Record<string, unknown>): Record<string, unknown> | undefined {
  if (record.type === "session_exit") return record;
  if (record.type !== "custom" || record.customType !== "session_exit" || !isRecord(record.data)) return undefined;
  return record.data;
}

function statusFromExit(exit: Record<string, unknown>): SessionStatus {
  if (Array.isArray(exit.pendingToolCalls) && exit.pendingToolCalls.length > 0) return "working";
  const kind = stringValue(exit.kind);
  if (kind === "normal") return "done";
  if (kind === "fatal") return "error";
  if (kind === "signal" || kind === "process_exit") return "exited";
  return "exited";
}

function statusFromMessage(message: Record<string, unknown>): SessionStatus | undefined {
  const role = stringValue(message.role);
  if (role === "user") return "working";
  if (role === "toolResult" || role === "tool_result") return "working";
  if (role !== "assistant") return undefined;

  const stopReason = stringValue(message.stopReason);
  if (stopReason === "error") return "error";
  if (stopReason === "aborted" || stopReason === "length") return "exited";
  if (Array.isArray(message.content) && message.content.some(isToolCallBlock)) return "working";
  return "done";
}

function isToolCallBlock(value: unknown): boolean {
  return isRecord(value) && (value.type === "toolCall" || value.type === "tool_call" || value.type === "toolUse");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}
