import {
  createLogger,
  errorMessage,
  paginateFromEnd,
  type SessionMessagesResponse,
  truncateId,
} from "@agent-town/shared";

import { matchTexts, type SearchMessageResult } from "../search";
import { parseTreeSession } from "../tree-session";
import { discoverPiSessions, findPiSessionPath, getPiSessionsDir } from "./session-discovery";

const log = createLogger("pi:messages");

export async function getPiSessionMessages(
  sessionId: string,
  offset: number,
  limit: number,
  sessionsDir = getPiSessionsDir(),
): Promise<SessionMessagesResponse> {
  const messages = await loadPiMessages(sessionId, sessionsDir);
  if (!messages) {
    log.warn(`session not found: sessionId=${truncateId(sessionId)}`);
    throw new Error("Session not found");
  }
  const { slice, hasMore } = paginateFromEnd(messages, offset, limit);
  return { messages: slice, total: messages.length, hasMore };
}

export async function searchPiMessages(
  query: string,
  maxResults: number,
  sessionsDir = getPiSessionsDir(),
): Promise<SearchMessageResult[]> {
  if (maxResults <= 0) return [];
  const normalizedQuery = query.toLowerCase();
  const sessions = await discoverPiSessions({ sessionsDir });
  const results: SearchMessageResult[] = [];

  for (const session of sessions) {
    if (results.length >= maxResults) break;
    try {
      const messages = await loadPiMessages(session.sessionId, sessionsDir);
      if (!messages) continue;
      const { matchCount, snippet } = matchTexts(
        messages.flatMap((message) => [message.content, message.thinking ?? ""]),
        normalizedQuery,
      );
      if (matchCount > 0) {
        results.push({
          sessionId: session.sessionId,
          agentType: "pi",
          snippet,
          matchCount,
        });
      }
    } catch (err) {
      log.debug(`search skipped session=${truncateId(session.sessionId)}: ${errorMessage(err)}`);
    }
  }
  return results;
}

async function loadPiMessages(sessionId: string, sessionsDir: string) {
  const path = await findPiSessionPath(sessionId, sessionsDir);
  if (!path) return null;
  try {
    return parseTreeSession(await Bun.file(path).text())?.messages ?? null;
  } catch (err) {
    log.debug(`message read failed: session=${truncateId(sessionId)} error=${errorMessage(err)}`);
    return null;
  }
}
