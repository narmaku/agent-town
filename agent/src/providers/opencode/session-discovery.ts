import { homedir } from "node:os";
import { join } from "node:path";
import {
  calculateCost,
  createLogger,
  SESSION_RETENTION_MS,
  type SessionInfo,
  type SessionStatus,
} from "@agent-town/shared";
import { getOpenCodeClient, resetOpenCodeClient } from "./sdk-client";

const log = createLogger("opencode:sessions");

function getOpenCodeDataDir(): string {
  if (process.platform === "darwin") {
    return join(homedir(), "Library", "Application Support", "opencode");
  }
  return join(homedir(), ".local", "share", "opencode");
}

const OPENCODE_DB_PATH = join(getOpenCodeDataDir(), "opencode.db");

/**
 * Discover OpenCode sessions.
 * Uses the SDK REST API if the server is running, falls back to SQLite.
 */
export async function discoverOpenCodeSessions(): Promise<SessionInfo[]> {
  // Try SDK first
  const client = await getOpenCodeClient();
  if (client) {
    try {
      return await discoverViaSDK(client);
    } catch (err) {
      log.debug(
        `SDK session discovery failed, falling back to SQLite: ${err instanceof Error ? err.message : String(err)}`,
      );
      resetOpenCodeClient();
    }
  }

  // Fallback: direct SQLite
  return discoverViaSQLite();
}

async function discoverViaSDK(
  client: NonNullable<Awaited<ReturnType<typeof getOpenCodeClient>>>,
): Promise<SessionInfo[]> {
  const { data: sessions } = await client.session.list({ roots: true });
  if (!sessions) return [];

  const sevenDaysAgoMs = Date.now() - SESSION_RETENTION_MS;

  // Get session statuses for all sessions
  const { data: statuses } = await client.session.status();

  const results: SessionInfo[] = [];
  for (const s of sessions) {
    const timeUpdated = s.time?.updated ?? 0;
    if (timeUpdated < sevenDaysAgoMs) continue;

    // SDK status: { type: "idle" } | { type: "busy" } | { type: "retry" }
    const sdkStatus = statuses?.[s.id];
    const status = mapSDKStatus(sdkStatus, timeUpdated);

    // Extract token usage from SDK session metadata if available
    const sdkSession = s as Record<string, unknown>;
    const tokens = sdkSession.tokens as { input?: number; output?: number } | undefined;
    let totalInputTokens: number | undefined;
    let totalOutputTokens: number | undefined;
    if (tokens) {
      if (typeof tokens.input === "number" && tokens.input > 0) totalInputTokens = tokens.input;
      if (typeof tokens.output === "number" && tokens.output > 0) totalOutputTokens = tokens.output;
    }
    const model = (sdkSession.modelID as string) || undefined;
    const estimatedCost =
      totalInputTokens || totalOutputTokens
        ? calculateCost(totalInputTokens ?? 0, totalOutputTokens ?? 0, model)
        : undefined;

    results.push({
      sessionId: s.id,
      agentType: "opencode",
      slug: s.id.replace(/^ses_/, "").slice(0, 8),
      projectPath: s.directory || "",
      projectName: s.directory?.split("/").pop() || "unknown",
      gitBranch: "",
      status,
      lastActivity: new Date(timeUpdated).toISOString(),
      lastMessage: s.title || "OpenCode session",
      cwd: s.directory || "",
      model,
      totalInputTokens,
      totalOutputTokens,
      estimatedCost,
    });
  }

  log.debug(`discoverViaSDK: found ${results.length} session(s)`);
  return results;
}

function mapSDKStatus(sdkStatus: { type: string } | undefined, timeUpdated: number): SessionStatus {
  if (sdkStatus) {
    switch (sdkStatus.type) {
      case "busy":
        return "working";
      case "retry":
        return "working";
      case "idle":
        return "awaiting_input";
    }
  }

  // Fallback: time-based heuristic
  const ageMs = Date.now() - timeUpdated;
  if (ageMs < 5_000) return "working";
  if (ageMs < 10 * 60 * 1000) return "awaiting_input";
  return "done";
}

// --- SQLite fallback ---

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
      let estimatedCost: number | undefined;
      try {
        const tokenRow = db
          .query<TokenAggregateRow, [string]>(
            `SELECT
               SUM(CAST(json_extract(data, '$.tokens.input') AS INTEGER)) as total_input,
               SUM(CAST(json_extract(data, '$.tokens.output') AS INTEGER)) as total_output,
               json_extract(data, '$.modelID') as model_id
             FROM message
             WHERE session_id = ?
               AND json_extract(data, '$.role') = 'assistant'
               AND json_extract(data, '$.tokens') IS NOT NULL
             ORDER BY time_created DESC
             LIMIT 1`,
          )
          .get(row.id);
        if (tokenRow) {
          if (tokenRow.total_input && tokenRow.total_input > 0) totalInputTokens = tokenRow.total_input;
          if (tokenRow.total_output && tokenRow.total_output > 0) totalOutputTokens = tokenRow.total_output;
          if (tokenRow.model_id) model = tokenRow.model_id;
          if (totalInputTokens || totalOutputTokens) {
            estimatedCost = calculateCost(totalInputTokens ?? 0, totalOutputTokens ?? 0, model);
          }
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
        estimatedCost,
      });
    }

    db.close();
  } catch (err) {
    log.debug(`discoverViaSQLite: ${err instanceof Error ? err.message : String(err)}`);
  }

  return sessions;
}

/** Delete an OpenCode session. Uses SDK if available, falls back to SQLite. */
export async function deleteOpenCodeSessionData(sessionId: string): Promise<boolean> {
  const client = await getOpenCodeClient();
  if (client) {
    try {
      const { data } = await client.session.delete({ sessionID: sessionId });
      if (data) {
        log.info(`deleted OpenCode session via SDK: ${sessionId}`);
        return true;
      }
    } catch (err) {
      log.debug(`SDK delete failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // Fallback: SQLite
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
    log.warn(`deleteOpenCodeSessionData: ${err instanceof Error ? err.message : String(err)}`);
  }
  return false;
}

/** Find the most recently updated session in a directory (for process matching). */
export async function findOpenCodeSessionByDir(
  directory: string,
  claimedIds: Set<string>,
): Promise<string | undefined> {
  const client = await getOpenCodeClient();
  if (client) {
    try {
      const { data: sessions } = await client.session.list({ roots: true });
      if (sessions) {
        const sorted = sessions
          .filter((s) => s.directory === directory && !claimedIds.has(s.id))
          .sort((a, b) => (b.time?.updated ?? 0) - (a.time?.updated ?? 0));
        if (sorted.length > 0) return sorted[0].id;
      }
    } catch (err) {
      log.debug(
        `findOpenCodeSessionByDir: SDK lookup failed, falling back to SQLite: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  // Fallback: SQLite
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
    log.debug(`findOpenCodeSessionByDir: ${err instanceof Error ? err.message : String(err)}`);
  }
  return undefined;
}

export { OPENCODE_DB_PATH };
