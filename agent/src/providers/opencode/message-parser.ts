import {
  createLogger,
  errorMessage,
  type SessionMessage,
  type SessionMessagesResponse,
  safeJsonParse,
  type TokenUsage,
  truncateId,
} from "@agent-town/shared";
import { extractSnippet, type SearchMessageResult } from "../search";
import { OPENCODE_DB_PATH } from "./session-discovery";

const log = createLogger("opencode:messages");

/** Get paginated messages for an OpenCode session from its local SQLite database. */
export async function getOpenCodeSessionMessages(
  sessionId: string,
  offset: number,
  limit: number,
): Promise<SessionMessagesResponse> {
  return getMessagesViaSQLite(sessionId, offset, limit);
}

interface MessageRow {
  id: string;
  time_created: number;
  data: string;
}

interface PartRow {
  id: string;
  message_id: string;
  data: string;
}

async function getMessagesViaSQLite(
  sessionId: string,
  offset: number,
  limit: number,
): Promise<SessionMessagesResponse> {
  try {
    const { Database } = await import("bun:sqlite");
    const db = new Database(OPENCODE_DB_PATH, { readonly: true });

    const countRow = db
      .query<{ total: number }, [string]>(
        `SELECT COUNT(*) as total FROM message
       WHERE session_id = ?
         AND json_extract(data, '$.role') IN ('user', 'assistant')`,
      )
      .get(sessionId);
    const total = countRow?.total ?? 0;

    if (total === 0) {
      db.close();
      return { messages: [], total: 0, hasMore: false };
    }

    const startFromEnd = offset + limit;
    const sqlOffset = Math.max(0, total - startFromEnd);
    const sqlLimit = Math.min(limit, total - offset);

    const messageRows = db
      .query<MessageRow, [string, number, number]>(
        `SELECT id, time_created, data FROM message
       WHERE session_id = ?
         AND json_extract(data, '$.role') IN ('user', 'assistant')
       ORDER BY time_created ASC
       LIMIT ? OFFSET ?`,
      )
      .all(sessionId, sqlLimit, sqlOffset);

    const messageIds = messageRows.map((m) => m.id);
    const partRows =
      messageIds.length > 0
        ? db
            .query<PartRow, []>(
              `SELECT id, message_id, data FROM part
           WHERE message_id IN (${messageIds.map(() => "?").join(",")})
           ORDER BY id ASC`,
            )
            .all(...(messageIds as []))
        : [];

    const partsByMessage = new Map<string, PartRow[]>();
    for (const part of partRows) {
      const existing = partsByMessage.get(part.message_id) || [];
      existing.push(part);
      partsByMessage.set(part.message_id, existing);
    }

    const messages: SessionMessage[] = messageRows.map((row) => {
      const msgData = safeJsonParse<{
        role: string;
        modelID?: string;
        providerID?: string;
        tokens?: { input?: number; output?: number };
      }>(row.data);
      const parts = partsByMessage.get(row.id) || [];
      const role = (msgData?.role || "user") as "user" | "assistant";

      const textParts: string[] = [];
      const toolUse: { name: string; id: string; input?: string }[] = [];
      const toolResults: { toolUseId: string; content: string }[] = [];

      for (const part of parts) {
        const partData = safeJsonParse<{
          type: string;
          text?: string;
          name?: string;
          toolCallId?: string;
          args?: Record<string, unknown>;
          result?: string;
          state?: string;
        }>(part.data);
        if (!partData) continue;

        if (partData.type === "text" && partData.text) {
          textParts.push(partData.text);
        } else if (partData.type === "tool-invocation" && partData.name) {
          const id = partData.toolCallId || part.id;
          const input = partData.args ? JSON.stringify(partData.args, null, 2).slice(0, 2000) : undefined;
          toolUse.push({ name: partData.name, id, input });
          if (typeof partData.result === "string") {
            toolResults.push({ toolUseId: id, content: partData.result.slice(0, 2000) });
          }
        }
      }

      const model = msgData?.modelID ? `${msgData.providerID || ""}/${msgData.modelID}` : undefined;

      // Extract token usage if available
      let tokenUsage: TokenUsage | undefined;
      const tokens = msgData?.tokens;
      if (tokens && (typeof tokens.input === "number" || typeof tokens.output === "number")) {
        tokenUsage = {};
        if (typeof tokens.input === "number") tokenUsage.inputTokens = tokens.input;
        if (typeof tokens.output === "number") tokenUsage.outputTokens = tokens.output;
      }

      return {
        role,
        timestamp: new Date(row.time_created).toISOString(),
        content: textParts.join("\n\n"),
        toolUse: toolUse.length > 0 ? toolUse : undefined,
        toolResults: toolResults.length > 0 ? toolResults : undefined,
        model: model?.startsWith("/") ? model.slice(1) : model,
        tokenUsage,
      };
    });

    db.close();

    const hasMore = sqlOffset > 0;
    log.debug(
      `getOpenCodeSessionMessages (SQLite): session=${truncateId(sessionId)} total=${total} returned=${messages.length} offset=${offset}`,
    );
    return { messages, total, hasMore };
  } catch (err) {
    log.warn(`getOpenCodeSessionMessages: ${errorMessage(err)}`);
    throw new Error("Session not found");
  }
}

/** Search OpenCode message parts for `query` (already lower-cased). */
export async function searchOpenCodeMessages(
  query: string,
  maxResults: number,
  dbPath = OPENCODE_DB_PATH,
): Promise<SearchMessageResult[]> {
  if (maxResults <= 0) return [];
  const { Database } = await import("bun:sqlite");
  const db = new Database(dbPath, { readonly: true });
  try {
    const rows = db
      .query<{ session_id: string; text_content: string | null; match_count: number }, [string, number]>(
        `SELECT m.session_id,
                (SELECT p2.data FROM part p2
                 WHERE p2.message_id = m.id
                   AND p2.data LIKE '%' || ?1 || '%'
                 LIMIT 1) as text_content,
                COUNT(*) as match_count
         FROM message m
         JOIN part p ON p.message_id = m.id
         WHERE p.data LIKE '%' || ?1 || '%'
         GROUP BY m.session_id
         ORDER BY match_count DESC
         LIMIT ?2`,
      )
      .all(query, maxResults);
    return rows.map((row) => {
      const partText = row.text_content ? (safeJsonParse<{ text?: string }>(row.text_content)?.text ?? "") : "";
      const index = partText.toLowerCase().indexOf(query);
      return {
        sessionId: row.session_id,
        agentType: "opencode" as const,
        snippet: index >= 0 ? extractSnippet(partText, index, query.length) : "",
        matchCount: row.match_count,
      };
    });
  } finally {
    db.close();
  }
}
