import {
  createLogger,
  paginateFromEnd,
  type SessionMessage,
  type SessionMessagesResponse,
  safeJsonParse,
  truncateId,
} from "@agent-town/shared";
import { getOpenCodeClient, resetOpenCodeClient } from "./sdk-client";
import { OPENCODE_DB_PATH } from "./session-discovery";

const log = createLogger("opencode:messages");

/**
 * Get paginated messages for an OpenCode session.
 * Uses SDK REST API if available, falls back to SQLite.
 */
export async function getOpenCodeSessionMessages(
  sessionId: string,
  offset: number,
  limit: number,
): Promise<SessionMessagesResponse> {
  const client = await getOpenCodeClient();
  if (client) {
    try {
      return await getMessagesViaSDK(client, sessionId, offset, limit);
    } catch (err) {
      log.debug(`SDK messages failed, falling back to SQLite: ${err instanceof Error ? err.message : String(err)}`);
      resetOpenCodeClient();
    }
  }

  return getMessagesViaSQLite(sessionId, offset, limit);
}

async function getMessagesViaSDK(
  client: NonNullable<Awaited<ReturnType<typeof getOpenCodeClient>>>,
  sessionId: string,
  offset: number,
  limit: number,
): Promise<SessionMessagesResponse> {
  const { data } = await client.session.messages({ sessionID: sessionId });
  if (!data) throw new Error("Session not found");

  // data is Array<{ info: Message, parts: Part[] }>
  // Filter to user/assistant only
  const allMessages = data.filter((m) => m.info.role === "user" || m.info.role === "assistant");

  const total = allMessages.length;
  const { slice, hasMore } = paginateFromEnd(allMessages, offset, limit);

  const messages: SessionMessage[] = slice.map((m) => {
    const textParts: string[] = [];
    const toolUse: { name: string; id: string }[] = [];

    for (const part of m.parts) {
      if (part.type === "text" && part.text) {
        textParts.push(part.text);
      } else if (part.type === "tool-invocation" || (part as Record<string, unknown>).type === "tool") {
        const p = part as Record<string, unknown>;
        const name = (p.name || p.toolName || "unknown") as string;
        toolUse.push({ name, id: (p.toolCallId || part.id) as string });
      }
    }

    const assistantInfo = m.info as Record<string, unknown>;
    const modelID = (assistantInfo.modelID || "") as string;
    const providerID = (assistantInfo.providerID || "") as string;
    const model = modelID ? (providerID ? `${providerID}/${modelID}` : modelID) : undefined;

    return {
      role: m.info.role as "user" | "assistant",
      timestamp: new Date(m.info.time.created).toISOString(),
      content: textParts.join("\n\n"),
      toolUse: toolUse.length > 0 ? toolUse : undefined,
      model,
    };
  });

  log.debug(
    `getOpenCodeSessionMessages (SDK): session=${truncateId(sessionId)} total=${total} returned=${messages.length} offset=${offset}`,
  );
  return { messages, total, hasMore };
}

// --- SQLite fallback ---

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
      const msgData = safeJsonParse<{ role: string; modelID?: string; providerID?: string }>(row.data);
      const parts = partsByMessage.get(row.id) || [];
      const role = (msgData?.role || "user") as "user" | "assistant";

      const textParts: string[] = [];
      const toolUse: { name: string; id: string }[] = [];

      for (const part of parts) {
        const partData = safeJsonParse<{ type: string; text?: string; name?: string; toolCallId?: string }>(part.data);
        if (!partData) continue;

        if (partData.type === "text" && partData.text) {
          textParts.push(partData.text);
        } else if (partData.type === "tool-invocation" && partData.name) {
          toolUse.push({ name: partData.name, id: partData.toolCallId || part.id });
        }
      }

      const model = msgData?.modelID ? `${msgData.providerID || ""}/${msgData.modelID}` : undefined;

      return {
        role,
        timestamp: new Date(row.time_created).toISOString(),
        content: textParts.join("\n\n"),
        toolUse: toolUse.length > 0 ? toolUse : undefined,
        model: model?.startsWith("/") ? model.slice(1) : model,
      };
    });

    db.close();

    const hasMore = sqlOffset > 0;
    log.debug(
      `getOpenCodeSessionMessages (SQLite): session=${truncateId(sessionId)} total=${total} returned=${messages.length} offset=${offset}`,
    );
    return { messages, total, hasMore };
  } catch (err) {
    log.warn(`getOpenCodeSessionMessages: ${err instanceof Error ? err.message : String(err)}`);
    throw new Error("Session not found");
  }
}
