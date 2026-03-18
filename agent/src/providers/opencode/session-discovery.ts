import { homedir } from "node:os";
import { join } from "node:path";
import { createLogger, type SessionInfo, type SessionStatus } from "@agent-town/shared";

const log = createLogger("opencode:sessions");

function getOpenCodeDataDir(): string {
  if (process.platform === "darwin") {
    return join(homedir(), "Library", "Application Support", "opencode");
  }
  return join(homedir(), ".local", "share", "opencode");
}

const OPENCODE_DB_PATH = join(getOpenCodeDataDir(), "opencode.db");

interface SessionRow {
  id: string;
  title: string;
  directory: string;
  slug: string;
  parent_id: string | null;
  time_created: number; // unix ms
  time_updated: number; // unix ms
}

interface MessageDataRow {
  data: string;
}

/**
 * Discover OpenCode sessions by reading the SQLite database directly.
 */
export async function discoverOpenCodeSessions(): Promise<SessionInfo[]> {
  const sessions: SessionInfo[] = [];

  try {
    const { Database } = await import("bun:sqlite");
    const db = new Database(OPENCODE_DB_PATH, { readonly: true });

    const sevenDaysAgoMs = Date.now() - 7 * 24 * 60 * 60 * 1000;
    const rows = db
      .query<SessionRow, [number]>(
        `SELECT id, title, directory, slug, parent_id, time_created, time_updated
       FROM session
       WHERE time_updated > ?
         AND parent_id IS NULL
       ORDER BY time_updated DESC`,
      )
      .all(sevenDaysAgoMs);

    for (const row of rows) {
      const status = detectOpenCodeStatus(row);
      const model = getSessionModel(db, row.id);

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
      });
    }

    db.close();
  } catch (err) {
    log.debug(`discoverOpenCodeSessions: db not accessible: ${err instanceof Error ? err.message : String(err)}`);
  }

  return sessions;
}

function detectOpenCodeStatus(row: SessionRow): SessionStatus {
  const ageMs = Date.now() - row.time_updated;

  // OpenCode's time_updated marks when the last response finished,
  // not during streaming. Use a tight threshold for "working".
  if (ageMs < 5_000) return "working";
  if (ageMs < 10 * 60 * 1000) return "awaiting_input";

  return "done";
}

/** Extract model info from the first assistant message's data JSON. */
function getSessionModel(
  db: InstanceType<typeof import("bun:sqlite").Database>,
  sessionId: string,
): string | undefined {
  try {
    const row = db
      .query<MessageDataRow, [string]>(
        `SELECT data FROM message
       WHERE session_id = ?
       ORDER BY time_created ASC
       LIMIT 2`,
      )
      .all(sessionId);

    for (const r of row) {
      try {
        const parsed = JSON.parse(r.data);
        if (parsed.providerID && parsed.modelID) {
          return `${parsed.providerID}/${parsed.modelID}`;
        }
        if (parsed.model?.providerID && parsed.model?.modelID) {
          return `${parsed.model.providerID}/${parsed.model.modelID}`;
        }
      } catch {
        // skip
      }
    }
  } catch {
    // no messages
  }
  return undefined;
}

/** Delete an OpenCode session from the SQLite database. */
export async function deleteOpenCodeSessionData(sessionId: string): Promise<boolean> {
  try {
    const { Database } = await import("bun:sqlite");
    const db = new Database(OPENCODE_DB_PATH);

    // Foreign key cascades handle message/part cleanup
    const result = db.run("DELETE FROM session WHERE id = ?", sessionId);
    db.close();

    if (result.changes > 0) {
      log.info(`deleted OpenCode session: ${sessionId}`);
      return true;
    }
  } catch (err) {
    log.warn(`deleteOpenCodeSessionData failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  return false;
}

/**
 * Find the most recently updated OpenCode session in a given directory.
 * Used by the process mapper to link a running opencode process to its session.
 */
export async function findOpenCodeSessionByDir(directory: string, claimedIds: Set<string>): Promise<string | undefined> {
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
    log.debug(`findOpenCodeSessionByDir failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  return undefined;
}

export { OPENCODE_DB_PATH };
