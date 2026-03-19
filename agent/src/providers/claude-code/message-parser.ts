import { readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { createLogger, type SessionMessage, type SessionMessagesResponse } from "@agent-town/shared";

const log = createLogger("claude:messages");

export interface ClaudeMessageEntry {
  type: string;
  sessionId: string;
  timestamp: string;
  message: {
    role: string;
    model?: string;
    content?: unknown;
  };
}

export function formatClaudeEntry(entry: ClaudeMessageEntry): SessionMessage {
  const content = entry.message?.content;
  let textContent = "";
  let toolUse: { name: string; id: string }[] | undefined;
  let toolResult: string | undefined;

  if (typeof content === "string") {
    textContent = content;
  } else if (Array.isArray(content)) {
    const textParts: string[] = [];
    const tools: { name: string; id: string }[] = [];

    for (const block of content) {
      const b = block as Record<string, unknown>;
      if (b.type === "text" && typeof b.text === "string") {
        textParts.push(b.text);
      } else if (b.type === "tool_use" && typeof b.name === "string" && typeof b.id === "string") {
        tools.push({ name: b.name, id: b.id });
      } else if (b.type === "tool_result") {
        toolResult = typeof b.content === "string" ? b.content.slice(0, 500) : "[tool output]";
      }
    }

    textContent = textParts.join("\n\n");
    if (tools.length > 0) toolUse = tools;
  }

  return {
    role: entry.type as "user" | "assistant",
    timestamp: entry.timestamp,
    content: textContent,
    toolUse,
    toolResult,
    model: entry.message?.model,
  };
}

export async function getClaudeSessionMessages(
  sessionId: string,
  offset: number,
  limit: number,
): Promise<SessionMessagesResponse> {
  const filePath = await findJsonlFile(sessionId);
  if (!filePath) {
    log.warn(`session not found: sessionId=${sessionId.slice(0, 12)}`);
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
  const startFromEnd = offset + limit;
  const startIndex = Math.max(0, total - startFromEnd);
  const endIndex = Math.max(0, total - offset);
  const slice = entries.slice(startIndex, endIndex);
  const hasMore = startIndex > 0;

  const messages = slice.map(formatClaudeEntry);

  log.debug(
    `getClaudeSessionMessages: session=${sessionId.slice(0, 12)} total=${total} returned=${messages.length} offset=${offset}`,
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
