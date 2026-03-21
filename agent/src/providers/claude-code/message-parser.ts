import { readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  createLogger,
  paginateFromEnd,
  type SessionMessage,
  type SessionMessagesResponse,
  type TokenUsage,
  truncateId,
} from "@agent-town/shared";

const log = createLogger("claude:messages");

export interface ClaudeMessageEntry {
  type: string;
  sessionId: string;
  timestamp: string;
  message: {
    role: string;
    model?: string;
    content?: unknown;
    usage?: {
      input_tokens?: number;
      output_tokens?: number;
    };
  };
}

const TOOL_CONTENT_MAX_LENGTH = 2000;

export function formatClaudeEntry(entry: ClaudeMessageEntry): SessionMessage {
  const content = entry.message?.content;
  let textContent = "";
  let toolUse: { name: string; id: string; input?: string }[] | undefined;
  let toolResult: string | undefined;
  let toolResults: { toolUseId: string; content: string }[] | undefined;
  let thinking: string | undefined;

  if (typeof content === "string") {
    textContent = content;
  } else if (Array.isArray(content)) {
    const textParts: string[] = [];
    const tools: { name: string; id: string; input?: string }[] = [];
    const thinkingParts: string[] = [];
    const results: { toolUseId: string; content: string }[] = [];

    for (const block of content) {
      const b = block as Record<string, unknown>;
      if (b.type === "text" && typeof b.text === "string") {
        textParts.push(b.text);
      } else if (b.type === "thinking" && typeof b.thinking === "string") {
        thinkingParts.push(b.thinking);
      } else if (b.type === "tool_use" && typeof b.name === "string" && typeof b.id === "string") {
        const input = b.input ? JSON.stringify(b.input, null, 2).slice(0, TOOL_CONTENT_MAX_LENGTH) : undefined;
        tools.push({ name: b.name, id: b.id, input });
      } else if (b.type === "tool_result") {
        const resultContent = extractToolResultContent(b);
        const toolUseId = (b.tool_use_id || b.id || "") as string;
        results.push({ toolUseId, content: resultContent });
        // Keep legacy single toolResult for backward compat
        if (!toolResult) {
          toolResult = typeof b.content === "string" ? b.content.slice(0, 500) : "[tool output]";
        }
      }
    }

    textContent = textParts.join("\n\n");
    if (tools.length > 0) toolUse = tools;
    if (thinkingParts.length > 0) thinking = thinkingParts.join("\n\n");
    if (results.length > 0) toolResults = results;
  }

  // Extract token usage from message.usage if present
  let tokenUsage: TokenUsage | undefined;
  const usage = entry.message?.usage;
  if (usage && (typeof usage.input_tokens === "number" || typeof usage.output_tokens === "number")) {
    tokenUsage = {};
    if (typeof usage.input_tokens === "number") tokenUsage.inputTokens = usage.input_tokens;
    if (typeof usage.output_tokens === "number") tokenUsage.outputTokens = usage.output_tokens;
  }

  return {
    role: entry.type as "user" | "assistant",
    timestamp: entry.timestamp,
    content: textContent,
    toolUse,
    toolResult,
    toolResults,
    thinking,
    model: entry.message?.model,
    tokenUsage,
  };
}

function extractToolResultContent(b: Record<string, unknown>): string {
  if (typeof b.content === "string") {
    return b.content.slice(0, TOOL_CONTENT_MAX_LENGTH);
  }
  if (Array.isArray(b.content)) {
    return (b.content as Array<Record<string, unknown>>)
      .filter((c) => c.type === "text" && typeof c.text === "string")
      .map((c) => c.text as string)
      .join("\n")
      .slice(0, TOOL_CONTENT_MAX_LENGTH);
  }
  return "[tool output]";
}

export async function getClaudeSessionMessages(
  sessionId: string,
  offset: number,
  limit: number,
): Promise<SessionMessagesResponse> {
  const filePath = await findJsonlFile(sessionId);
  if (!filePath) {
    log.warn(`session not found: sessionId=${truncateId(sessionId)}`);
    throw new Error("Session not found");
  }

  const text = await Bun.file(filePath).text();
  const lines = text.trim().split("\n");

  const entries: ClaudeMessageEntry[] = [];
  for (const line of lines) {
    try {
      const entry: ClaudeMessageEntry = JSON.parse(line);
      if (entry.type === "user" || entry.type === "assistant") {
        entries.push(entry);
      }
    } catch (_err) {
      // skip malformed JSONL line
    }
  }

  const total = entries.length;
  const { slice, hasMore } = paginateFromEnd(entries, offset, limit);

  const messages = slice.map(formatClaudeEntry);

  log.debug(
    `getClaudeSessionMessages: session=${truncateId(sessionId)} total=${total} returned=${messages.length} offset=${offset}`,
  );
  return { messages, total, hasMore };
}

async function findJsonlFile(sessionId: string): Promise<string | null> {
  const projectsDir = join(homedir(), ".claude", "projects");
  const dirs = await readdir(projectsDir);

  for (const dir of dirs) {
    const dirPath = join(projectsDir, dir);
    const dirStat = await stat(dirPath);
    if (!dirStat.isDirectory()) continue;

    const jsonlPath = join(dirPath, `${sessionId}.jsonl`);
    try {
      await stat(jsonlPath);
      return jsonlPath;
    } catch (_err) {
      // not in this directory, continue searching
    }
  }
  return null;
}
