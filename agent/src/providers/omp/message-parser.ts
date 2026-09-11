import { createLogger, paginateFromEnd, type SessionMessagesResponse, truncateId } from "@agent-town/shared";

import type { SearchMessageResult } from "../../session-messages";
import { discoverOmpSessions, findOmpSessionPath, getOmpSessionsDir } from "./session-discovery";
import { parseOmpSession } from "./session-parser";

const log = createLogger("omp:messages");
const SEARCH_SNIPPET_LENGTH = 120;

export async function getOmpSessionMessages(
  sessionId: string,
  offset: number,
  limit: number,
  sessionsDir = getOmpSessionsDir(),
): Promise<SessionMessagesResponse> {
  const messages = await loadOmpMessages(sessionId, sessionsDir);
  if (!messages) {
    log.warn(`session not found: sessionId=${truncateId(sessionId)}`);
    throw new Error("Session not found");
  }
  const { slice, hasMore } = paginateFromEnd(messages, offset, limit);
  return { messages: slice, total: messages.length, hasMore };
}

export async function searchOmpMessages(
  query: string,
  maxResults: number,
  sessionsDir = getOmpSessionsDir(),
): Promise<SearchMessageResult[]> {
  if (maxResults <= 0) return [];
  const normalizedQuery = query.toLowerCase();
  const sessions = await discoverOmpSessions({ sessionsDir });
  const results: SearchMessageResult[] = [];

  for (const session of sessions) {
    if (results.length >= maxResults) break;
    try {
      const messages = await loadOmpMessages(session.sessionId, sessionsDir);
      if (!messages) continue;
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
      if (matchCount > 0) {
        results.push({
          sessionId: session.sessionId,
          agentType: "omp",
          snippet,
          matchCount,
        });
      }
    } catch (err) {
      log.debug(`search skipped session=${truncateId(session.sessionId)}: ${formatError(err)}`);
    }
  }
  return results;
}

async function loadOmpMessages(sessionId: string, sessionsDir: string) {
  const path = await findOmpSessionPath(sessionId, sessionsDir);
  if (!path) return null;
  try {
    return parseOmpSession(await Bun.file(path).text())?.messages ?? null;
  } catch (err) {
    log.debug(`message read failed: session=${truncateId(sessionId)} error=${formatError(err)}`);
    return null;
  }
}

function extractSnippet(content: string, index: number, queryLength: number): string {
  if (content.length <= SEARCH_SNIPPET_LENGTH) return content;
  const context = Math.floor((SEARCH_SNIPPET_LENGTH - queryLength) / 2);
  const start = Math.max(0, Math.min(index - context, content.length - SEARCH_SNIPPET_LENGTH));
  const value = content.slice(start, start + SEARCH_SNIPPET_LENGTH);
  return `${start > 0 ? "…" : ""}${value}${start + SEARCH_SNIPPET_LENGTH < content.length ? "…" : ""}`;
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
