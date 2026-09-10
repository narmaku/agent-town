import { readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join } from "node:path";

import { createLogger, SESSION_RETENTION_MS, type SessionInfo, type SessionStatus } from "@agent-town/shared";
import { Database } from "bun:sqlite";

const log = createLogger("codex:sessions");

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DATABASE_FILE_RE = /^(?:state|thread_history)_\d+\.sqlite$/;
const MAX_ROLLOUT_FILES = 500;
const MAX_DISCOVERY_BYTES = 512 * 1024;

interface DiscoveryOptions {
  codexHome?: string;
  nowMs?: number;
}

interface DatabaseRow {
  [key: string]: unknown;
}

interface CachedDiscovery {
  fingerprint: string;
  sessions: SessionInfo[];
}

let discoveryCache: CachedDiscovery | undefined;

export function getCodexHome(): string {
  return process.env.CODEX_HOME || join(homedir(), ".codex");
}

export function clearCodexSessionCache(): void {
  discoveryCache = undefined;
}

export async function discoverCodexSessions(options: DiscoveryOptions = {}): Promise<SessionInfo[]> {
  const codexHome = options.codexHome ?? getCodexHome();
  const nowMs = options.nowMs ?? Date.now();
  const databasePaths = await findDatabasePaths(codexHome);
  const rolloutPaths = await findRolloutPaths(codexHome, nowMs);
  const fingerprint = await buildFingerprint([...databasePaths, ...rolloutPaths]);

  if (discoveryCache?.fingerprint === fingerprint) {
    return discoveryCache.sessions.map((session) => ({ ...session, status: detectStatus(session.lastActivity, nowMs) }));
  }

  const databaseSessions = discoverFromDatabases(databasePaths, nowMs);
  const sessions = databaseSessions ?? (await discoverFromRollouts(rolloutPaths, nowMs));
  sessions.sort((a, b) => Date.parse(b.lastActivity) - Date.parse(a.lastActivity));
  discoveryCache = { fingerprint, sessions };
  return sessions.map((session) => ({ ...session }));
}

async function findDatabasePaths(codexHome: string): Promise<string[]> {
  try {
    const entries = await readdir(codexHome, { withFileTypes: true });
    const paths = entries.filter((entry) => entry.isFile() && DATABASE_FILE_RE.test(entry.name)).map((entry) => join(codexHome, entry.name));
    const withMtime = await Promise.all(paths.map(async (path) => ({ path, mtimeMs: (await stat(path)).mtimeMs })));
    return withMtime.sort((a, b) => b.mtimeMs - a.mtimeMs).map((entry) => entry.path);
  } catch (err) {
    log.debug(`database scan unavailable: ${formatError(err)}`);
    return [];
  }
}

async function findRolloutPaths(codexHome: string, nowMs: number): Promise<string[]> {
  const root = join(codexHome, "sessions");
  const paths: { path: string; mtimeMs: number }[] = [];

  async function visit(directory: string, depth: number): Promise<void> {
    if (depth > 4 || paths.length >= MAX_ROLLOUT_FILES) return;
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch (err) {
      log.debug(`rollout directory unavailable: ${formatError(err)}`);
      return;
    }
    for (const entry of entries) {
      if (paths.length >= MAX_ROLLOUT_FILES) break;
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        await visit(path, depth + 1);
      } else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
        try {
          const metadata = await stat(path);
          if (nowMs - metadata.mtimeMs <= SESSION_RETENTION_MS) paths.push({ path, mtimeMs: metadata.mtimeMs });
        } catch (err) {
          log.debug(`rollout metadata unavailable: ${formatError(err)}`);
        }
      }
    }
  }

  await visit(root, 0);
  return paths.sort((a, b) => b.mtimeMs - a.mtimeMs).map((entry) => entry.path);
}

async function buildFingerprint(paths: string[]): Promise<string> {
  const parts: string[] = [];
  for (const path of paths) {
    try {
      const metadata = await stat(path);
      parts.push(`${path}:${metadata.mtimeMs}:${metadata.size}`);
    } catch (err) {
      log.debug(`fingerprint metadata unavailable: ${formatError(err)}`);
    }
  }
  return parts.join("|");
}

function discoverFromDatabases(paths: string[], nowMs: number): SessionInfo[] | null {
  for (const path of paths) {
    let db: Database | undefined;
    try {
      db = new Database(path, { readonly: true, strict: true });
      const tableNames = db.query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type = 'table'").all();
      const table = tableNames.find((entry) => entry.name === "threads" || entry.name === "thread")?.name;
      if (!table) continue;

      const columns = db.query<{ name: string }, []>(`PRAGMA table_info(${table})`).all().map((column) => column.name);
      if (!columns.includes("id") || !columns.includes("cwd") || !columns.includes("updated_at")) continue;

      const rows = db.query<DatabaseRow, []>(`SELECT * FROM ${table}`).all();
      return rows.flatMap((row) => {
        const session = sessionFromDatabaseRow(row, nowMs);
        return session ? [session] : [];
      });
    } catch (err) {
      log.debug(`incompatible Codex database ${basename(path)}: ${formatError(err)}`);
    } finally {
      db?.close();
    }
  }
  return null;
}

function sessionFromDatabaseRow(row: DatabaseRow, nowMs: number): SessionInfo | null {
  const id = stringValue(row.id);
  const cwd = stringValue(row.cwd);
  const updatedMs = timestampMs(row.updated_at);
  if (!id || !UUID_RE.test(id) || !cwd || !updatedMs) return null;
  if (isTruthy(row.archived) || isSubagentSource(row.source) || nowMs - updatedMs > SESSION_RETENTION_MS) return null;

  const title = stringValue(row.title) || id.slice(0, 8);
  return {
    sessionId: id,
    agentType: "codex",
    slug: title.slice(0, 100),
    projectPath: cwd,
    projectName: basename(cwd),
    gitBranch: stringValue(row.git_branch) || "",
    status: detectStatus(new Date(updatedMs).toISOString(), nowMs),
    lastActivity: new Date(updatedMs).toISOString(),
    lastMessage: title,
    cwd,
    model: stringValue(row.model) || stringValue(row.model_provider) || undefined,
    version: stringValue(row.cli_version) || undefined,
    totalInputTokens: numberValue(row.input_tokens) || undefined,
    totalOutputTokens: numberValue(row.output_tokens) || undefined,
  };
}

async function discoverFromRollouts(paths: string[], nowMs: number): Promise<SessionInfo[]> {
  const sessions: SessionInfo[] = [];
  for (const path of paths) {
    try {
      const metadata = await stat(path);
      const text = await Bun.file(path).slice(0, MAX_DISCOVERY_BYTES).text();
      const session = parseRolloutCatalogEntry(text, metadata.mtimeMs, nowMs);
      if (session) sessions.push(session);
    } catch (err) {
      log.debug(`rollout discovery skipped ${basename(path)}: ${formatError(err)}`);
    }
  }
  return sessions;
}

function parseRolloutCatalogEntry(text: string, mtimeMs: number, nowMs: number): SessionInfo | null {
  let metadata: Record<string, unknown> | undefined;
  let lastMessage = "";
  let model: string | undefined;
  let totalInputTokens = 0;
  let totalOutputTokens = 0;

  for (const line of text.split("\n")) {
    const record = parseRecord(line);
    if (!record) continue;
    const payload = record.payload;
    if (!metadata && record.type === "session_meta" && isRecord(payload)) metadata = payload;
    if (!isRecord(payload)) continue;
    const payloadType = stringValue(payload.type);
    if (record.type === "event_msg" && (payloadType === "agent_message" || payloadType === "user_message")) {
      lastMessage = stringValue(payload.message).slice(0, 120);
    }
    if (record.type === "response_item" && payloadType === "message") {
      const role = stringValue(payload.role);
      if (role === "user" || role === "assistant") lastMessage = extractText(payload.content).slice(0, 120);
    }
    model = stringValue(payload.model) || model;
    const usage = isRecord(payload.info) ? payload.info : isRecord(payload.usage) ? payload.usage : undefined;
    if (usage) {
      totalInputTokens += numberValue(usage.input_tokens);
      totalOutputTokens += numberValue(usage.output_tokens);
    }
  }

  if (!metadata) return null;
  const id = stringValue(metadata.id);
  const cwd = stringValue(metadata.cwd);
  const timestamp = stringValue(metadata.timestamp) || new Date(mtimeMs).toISOString();
  if (!UUID_RE.test(id) || !cwd || isSubagentSource(metadata.source) || nowMs - mtimeMs > SESSION_RETENTION_MS) return null;

  const title = stringValue(metadata.title) || id.slice(0, 8);
  return {
    sessionId: id,
    agentType: "codex",
    slug: title.slice(0, 100),
    projectPath: cwd,
    projectName: basename(cwd),
    gitBranch: stringValue(metadata.git_branch) || "",
    status: detectStatus(new Date(mtimeMs).toISOString(), nowMs),
    lastActivity: timestamp,
    lastMessage,
    cwd,
    model: model || stringValue(metadata.model) || undefined,
    version: stringValue(metadata.cli_version) || undefined,
    totalInputTokens: totalInputTokens || undefined,
    totalOutputTokens: totalOutputTokens || undefined,
  };
}

export async function findCodexRolloutPath(sessionId: string, codexHome = getCodexHome()): Promise<string | null> {
  if (!UUID_RE.test(sessionId)) return null;
  const paths = await findRolloutPaths(codexHome, Date.now());
  for (const path of paths) {
    try {
      const header = await Bun.file(path).slice(0, 64 * 1024).text();
      const metadata = header.split("\n").map(parseRecord).find((record) => record?.type === "session_meta");
      if (isRecord(metadata?.payload) && metadata.payload.id === sessionId) return path;
    } catch (err) {
      log.debug(`rollout lookup skipped ${basename(path)}: ${formatError(err)}`);
    }
  }
  return null;
}

function detectStatus(lastActivity: string, nowMs: number): SessionStatus {
  const age = nowMs - Date.parse(lastActivity);
  if (age < 30_000) return "working";
  if (age < 60_000) return "awaiting_input";
  return "idle";
}

function parseRecord(line: string): Record<string, unknown> | undefined {
  if (!line.trim()) return undefined;
  try {
    const value: unknown = JSON.parse(line);
    return isRecord(value) ? value : undefined;
  } catch (_err) {
    return undefined;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function numberValue(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function timestampMs(value: unknown): number {
  if (typeof value === "number") return value < 10_000_000_000 ? value * 1000 : value;
  if (typeof value === "string") {
    const numeric = Number(value);
    if (Number.isFinite(numeric) && numeric > 0) return numeric < 10_000_000_000 ? numeric * 1000 : numeric;
    const parsed = Date.parse(value);
    return Number.isNaN(parsed) ? 0 : parsed;
  }
  return 0;
}

function isTruthy(value: unknown): boolean {
  return value === true || value === 1 || value === "1" || value === "true";
}

function isSubagentSource(value: unknown): boolean {
  if (typeof value === "string") return value.toLowerCase().includes("subagent");
  if (!isRecord(value)) return false;
  return "subagent" in value || Object.values(value).some((item) => isSubagentSource(item));
}

function extractText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .flatMap((item) => {
      if (!isRecord(item)) return [];
      const text = stringValue(item.text);
      return text ? [text] : [];
    })
    .join("\n\n");
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
