import { createLogger, type SessionMessage, type SessionMessagesResponse } from "@agent-town/shared";
import { OPENCODE_DB_PATH } from "./session-discovery";

const log = createLogger("opencode:messages");

interface MessageRow {
  id: string;
  time_created: number;
  data: string; // JSON: { role, model, providerID, modelID, ... }
}

interface PartRow {
  id: string;
  message_id: string;
  data: string; // JSON: { type, text, ... }
}

interface MessageData {
  role: string;
  modelID?: string;
  providerID?: string;
  model?: { modelID?: string; providerID?: string };
}

interface PartData {
  type: string;
  text?: string;
  name?: string;
  toolCallId?: string;
}

/**
 * Get paginated messages for an OpenCode session from SQLite.
 *
 * OpenCode stores messages in `message` table (metadata) and `part` table
 * (actual content). Each message has one or more parts.
 */
export async function getOpenCodeSessionMessages(
  sessionId: string,
  offset: number,
  limit: number,
): Promise<SessionMessagesResponse> {
  try {
    const { Database } = await import("bun:sqlite");
    const db = new Database(OPENCODE_DB_PATH, { readonly: true });

    // Count total messages (user + assistant only)
    const countRow = db
      .query<{ total: number }, [string]>(
        `SELECT COUNT(*) as total FROM message m
       WHERE m.session_id = ?
         AND json_extract(m.data, '$.role') IN ('user', 'assistant')`,
      )
      .get(sessionId);
    const total = countRow?.total ?? 0;

    if (total === 0) {
      db.close();
      return { messages: [], total: 0, hasMore: false };
    }

    // Paginate from the end (newest first, matching Claude Code behavior)
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

    // Fetch parts for all these messages in one query
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

    // Group parts by message
    const partsByMessage = new Map<string, PartRow[]>();
    for (const part of partRows) {
      const existing = partsByMessage.get(part.message_id) || [];
      existing.push(part);
      partsByMessage.set(part.message_id, existing);
    }

    const messages: SessionMessage[] = messageRows.map((row) => {
      const msgData = safeParseJson<MessageData>(row.data);
      const parts = partsByMessage.get(row.id) || [];
      const role = (msgData?.role || "user") as "user" | "assistant";

      const textParts: string[] = [];
      const toolUse: { name: string; id: string }[] = [];

      for (const part of parts) {
        const partData = safeParseJson<PartData>(part.data);
        if (!partData) continue;

        if (partData.type === "text" && partData.text) {
          textParts.push(partData.text);
        } else if (partData.type === "tool-invocation" && partData.name) {
          toolUse.push({ name: partData.name, id: partData.toolCallId || part.id });
        }
      }

      const model =
        msgData?.modelID || msgData?.model?.modelID
          ? `${msgData?.providerID || msgData?.model?.providerID || ""}/${msgData?.modelID || msgData?.model?.modelID || ""}`
          : undefined;

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
      `getOpenCodeSessionMessages: session=${sessionId.slice(0, 12)} total=${total} returned=${messages.length} offset=${offset}`,
    );
    return { messages, total, hasMore };
  } catch (err) {
    log.warn(`getOpenCodeSessionMessages failed: ${err instanceof Error ? err.message : String(err)}`);
    throw new Error("Session not found");
  }
}

function safeParseJson<T>(str: string): T | null {
  try {
    return JSON.parse(str) as T;
  } catch {
    return null;
  }
}
