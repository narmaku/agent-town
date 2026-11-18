import { homedir } from "node:os";
import { join } from "node:path";
import {
  createLogger,
  errorMessage,
  SESSION_RETENTION_MS,
  type SessionInfo,
  type SessionStatus,
} from "@agent-town/shared";

const log = createLogger("opencode:sessions");

function getOpenCodeDataDir(): string {
  if (process.platform === "darwin") {
    return join(homedir(), "Library", "Application Support", "opencode");
  }
  return join(homedir(), ".local", "share", "opencode");
}

const OPENCODE_DB_PATH = join(getOpenCodeDataDir(), "opencode.db");

/** Discover OpenCode sessions by reading its local SQLite database (read-only). */
export async function discoverOpenCodeSessions(): Promise<SessionInfo[]> {
  return discoverViaSQLite();
}

interface SessionRow {
  id: string;
  title: string;
  directory: string;
  slug: string;
  parent_id: string | null;
  time_created: number;
  time_updated: number;
}

interface TokenAggregateRow {
  total_input: number | null;
  total_output: number | null;
  model_id: string | null;
}

async function discoverViaSQLite(): Promise<SessionInfo[]> {
  const sessions: SessionInfo[] = [];

  try {
    const { Database } = await import("bun:sqlite");
    const db = new Database(OPENCODE_DB_PATH, { readonly: true });

    const sevenDaysAgoMs = Date.now() - SESSION_RETENTION_MS;
    const rows = db
      .query<SessionRow, [number]>(
        `SELECT id, title, directory, slug, parent_id, time_created, time_updated
       FROM session
       WHERE time_updated > ? AND parent_id IS NULL
       ORDER BY time_updated DESC`,
      )
      .all(sevenDaysAgoMs);

    for (const row of rows) {
      const ageMs = Date.now() - row.time_updated;
      const status: SessionStatus = ageMs < 5_000 ? "working" : ageMs < 10 * 60 * 1000 ? "awaiting_input" : "done";

      // Try to aggregate token usage from message data
      let totalInputTokens: number | undefined;
      let totalOutputTokens: number | undefined;
      let model: string | undefined;
      try {
        const tokenRow = db
          .query<TokenAggregateRow, [string, string]>(
            `SELECT
               SUM(CAST(json_extract(data, '$.tokens.input') AS INTEGER)) as total_input,
               SUM(CAST(json_extract(data, '$.tokens.output') AS INTEGER)) as total_output,
               (SELECT json_extract(data, '$.modelID')
                FROM message
                WHERE session_id = ?
                  AND json_extract(data, '$.role') = 'assistant'
                  AND json_extract(data, '$.modelID') IS NOT NULL
                ORDER BY time_created DESC
                LIMIT 1) as model_id
             FROM message
             WHERE session_id = ?
               AND json_extract(data, '$.role') = 'assistant'
               AND json_extract(data, '$.tokens') IS NOT NULL`,
          )
          .get(row.id, row.id);
        if (tokenRow) {
          if (tokenRow.total_input && tokenRow.total_input > 0) totalInputTokens = tokenRow.total_input;
          if (tokenRow.total_output && tokenRow.total_output > 0) totalOutputTokens = tokenRow.total_output;
          if (tokenRow.model_id) model = tokenRow.model_id;
        }
      } catch (_err) {
        // token aggregation is best-effort
      }

      sessions.push({
        sessionId: row.id,
        agentType: "opencode",
        slug: row.slug || row.id.replace(/^ses_/, "").slice(0, 8),
        projectPath: row.directory,
        projectName: row.directory.split("/").pop() || "unknown",
        gitBranch: "",
        status,
        lastActivity: new Date(row.time_updated).toISOString(),
        lastMessage: row.title || "OpenCode session",
        cwd: row.directory,
        model,
        totalInputTokens,
        totalOutputTokens,
      });
    }

    db.close();
  } catch (err) {
    log.debug(`discoverViaSQLite: ${errorMessage(err)}`);
  }

  return sessions;
}

/** Delete an OpenCode session from its local SQLite database. */
export async function deleteOpenCodeSessionData(sessionId: string): Promise<boolean> {
  try {
    const { Database } = await import("bun:sqlite");
    const db = new Database(OPENCODE_DB_PATH);
    const result = db.run("DELETE FROM session WHERE id = ?", sessionId);
    db.close();
    if (result.changes > 0) {
      log.info(`deleted OpenCode session via SQLite: ${sessionId}`);
      return true;
    }
  } catch (err) {
    log.warn(`deleteOpenCodeSessionData: ${errorMessage(err)}`);
  }
  return false;
}

/** Find the most recently updated session in a directory (for process matching). */
export async function findOpenCodeSessionByDir(
  directory: string,
  claimedIds: Set<string>,
): Promise<string | undefined> {
  try {
    const { Database } = await import("bun:sqlite");
    const db = new Database(OPENCODE_DB_PATH, { readonly: true });
    const rows = db
      .query<{ id: string }, [string]>(
        `SELECT id FROM session
       WHERE directory = ? AND parent_id IS NULL
       ORDER BY time_updated DESC`,
      )
      .all(directory);
    db.close();

    for (const row of rows) {
      if (!claimedIds.has(row.id)) return row.id;
    }
  } catch (err) {
    log.debug(`findOpenCodeSessionByDir: ${errorMessage(err)}`);
  }
  return undefined;
}

export { OPENCODE_DB_PATH };
