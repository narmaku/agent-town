import type { Dirent } from "node:fs";
import { readdir, stat, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { createLogger, SESSION_RETENTION_MS, type SessionInfo, type SessionStatus } from "@agent-town/shared";

import { parseTreeSession } from "../tree-session";

const log = createLogger("pi:sessions");
const MAX_SESSION_BYTES = 16 * 1024 * 1024;
const MAX_SESSION_FILES = 1_000;

export interface PiDiscoveryOptions {
  sessionsDir?: string;
  nowMs?: number;
}

export interface PiSessionCandidate {
  id: string;
  cwd: string;
  createdAtMs: number;
}

interface CachedFile {
  fingerprint: string;
  session: SessionInfo | null;
  createdAtMs?: number;
}

const fileCache = new Map<string, CachedFile>();
const sessionPaths = new Map<string, string>();
const sessionCreatedAt = new Map<string, number>();

export function getPiAgentDir(): string {
  return process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
}

export function getPiSessionsDir(): string {
  return process.env.PI_CODING_AGENT_SESSION_DIR || join(getPiAgentDir(), "sessions");
}

export function clearPiSessionCache(): void {
  fileCache.clear();
  sessionPaths.clear();
  sessionCreatedAt.clear();
}

export async function discoverPiSessions(options: PiDiscoveryOptions = {}): Promise<SessionInfo[]> {
  const sessionsDir = options.sessionsDir ?? getPiSessionsDir();
  const nowMs = options.nowMs ?? Date.now();
  const paths = await findPiSessionFiles(sessionsDir);
  const livePaths = new Set(paths);
  const sessions: SessionInfo[] = [];
  sessionPaths.clear();
  sessionCreatedAt.clear();

  for (const path of paths) {
    try {
      const metadata = await stat(path);
      if (metadata.size > MAX_SESSION_BYTES || nowMs - metadata.mtimeMs > SESSION_RETENTION_MS) {
        fileCache.delete(path);
        continue;
      }
      const fingerprint = `${metadata.mtimeMs}:${metadata.ctimeMs}:${metadata.size}`;
      let cached = fileCache.get(path);
      if (!cached || cached.fingerprint !== fingerprint) {
        const text = await Bun.file(path).text();
        const parsed = parseTreeSession(text);
        const session = parsed ? sessionFromParsed(parsed, metadata.mtimeMs, nowMs) : null;
        cached = {
          fingerprint,
          session,
          createdAtMs: parsed?.header.timestamp ? Date.parse(parsed.header.timestamp) : metadata.birthtimeMs || metadata.mtimeMs,
        };
        fileCache.set(path, cached);
      }
      if (!cached.session) continue;
      const session = { ...cached.session, status: detectStatus(cached.session.lastActivity, nowMs) };
      sessions.push(session);
      sessionPaths.set(session.sessionId, path);
      sessionCreatedAt.set(session.sessionId, cached.createdAtMs ?? metadata.birthtimeMs ?? metadata.mtimeMs);
    } catch (err) {
      log.debug(`session discovery skipped ${basename(path)}: ${formatError(err)}`);
    }
  }

  for (const path of fileCache.keys()) {
    if (!livePaths.has(path)) fileCache.delete(path);
  }
  sessions.sort((a, b) => Date.parse(b.lastActivity) - Date.parse(a.lastActivity));
  return sessions;
}

export async function findPiSessionCandidates(sessionsDir = getPiSessionsDir()): Promise<PiSessionCandidate[]> {
  const sessions = await discoverPiSessions({ sessionsDir });
  return sessions.map((session) => ({
    id: session.sessionId,
    cwd: session.cwd,
    createdAtMs: sessionCreatedAt.get(session.sessionId) ?? Date.parse(session.lastActivity),
  }));
}

export async function findPiSessionPath(sessionId: string, sessionsDir = getPiSessionsDir()): Promise<string | null> {
  if (!sessionId) return null;
  const cachedPath = sessionPaths.get(sessionId);
  if (cachedPath && (await Bun.file(cachedPath).exists())) return cachedPath;

  for (const path of await findPiSessionFiles(sessionsDir)) {
    try {
      const text = await Bun.file(path).text();
      if (parseTreeSession(text)?.header.id === sessionId) return path;
    } catch (err) {
      log.debug(`session lookup skipped ${basename(path)}: ${formatError(err)}`);
    }
  }
  return null;
}

export async function deletePiSessionData(sessionId: string, sessionsDir = getPiSessionsDir()): Promise<boolean> {
  const path = await findPiSessionPath(sessionId, sessionsDir);
  if (!path) return false;
  try {
    await unlink(path);
    fileCache.delete(path);
    sessionPaths.delete(sessionId);
    sessionCreatedAt.delete(sessionId);
    return true;
  } catch (err) {
    log.warn(`session delete failed: session=${sessionId.slice(0, 8)} error=${formatError(err)}`);
    return false;
  }
}

async function findPiSessionFiles(sessionsDir: string): Promise<string[]> {
  const paths: string[] = [];
  const rootEntries = await safeReadDir(sessionsDir);
  for (const entry of rootEntries) {
    if (paths.length >= MAX_SESSION_FILES) break;
    const path = join(sessionsDir, entry.name);
    if (entry.isFile() && entry.name.endsWith(".jsonl")) {
      paths.push(path);
      continue;
    }
    if (!entry.isDirectory()) continue;
    for (const child of await safeReadDir(path)) {
      if (paths.length >= MAX_SESSION_FILES) break;
      if (child.isFile() && child.name.endsWith(".jsonl")) paths.push(join(path, child.name));
    }
  }
  return paths;
}

async function safeReadDir(path: string): Promise<Dirent[]> {
  try {
    return await readdir(path, { withFileTypes: true });
  } catch (err) {
    log.debug(`session directory unavailable: ${formatError(err)}`);
    return [];
  }
}

function sessionFromParsed(
  parsed: NonNullable<ReturnType<typeof parseTreeSession>>,
  mtimeMs: number,
  nowMs: number,
): SessionInfo {
  const messages = parsed.messages;
  const last = messages.at(-1);
  const lastAssistant = messages.findLast((message) => message.role === "assistant" && message.content);
  const sessionInfo = parsed.records.find((record) => record.type === "session_info");
  const firstUser = messages.find((message) => message.role === "user" && message.content);
  const name = stringValue(sessionInfo?.name) || stringValue(sessionInfo?.title) || parsed.header.name;
  const lastActivity = last && Date.parse(last.timestamp) > 0 ? last.timestamp : new Date(mtimeMs).toISOString();
  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  for (const message of messages) {
    totalInputTokens += message.tokenUsage?.inputTokens ?? 0;
    totalOutputTokens += message.tokenUsage?.outputTokens ?? 0;
  }
  const model = messages.findLast((message) => message.model)?.model || parsed.header.model;
  const slug = (name || firstUser?.content || parsed.header.id).slice(0, 100);

  return {
    sessionId: parsed.header.id,
    agentType: "pi" as SessionInfo["agentType"],
    slug,
    projectPath: parsed.header.cwd,
    projectName: basename(parsed.header.cwd),
    gitBranch: stringValue(parsed.header.gitBranch) || stringValue(parsed.header.git_branch),
    status: detectStatus(lastActivity, nowMs),
    lastActivity,
    lastMessage: last?.content.slice(0, 120) ?? "",
    lastAssistantMessage: lastAssistant?.content,
    cwd: parsed.header.cwd,
    model,
    version: parsed.header.version ? String(parsed.header.version) : undefined,
    totalInputTokens: totalInputTokens || undefined,
    totalOutputTokens: totalOutputTokens || undefined,
    contextTokens: messages.findLast((message) => message.tokenUsage?.inputTokens)?.tokenUsage?.inputTokens,
  };
}

function detectStatus(lastActivity: string, nowMs: number): SessionStatus {
  const age = nowMs - Date.parse(lastActivity);
  if (age < 30_000) return "working";
  if (age < 60_000) return "awaiting_input";
  return "idle";
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
