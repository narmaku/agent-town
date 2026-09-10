import type { Dirent } from "node:fs";
import { readdir, rm, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, isAbsolute, join, relative } from "node:path";
import { createLogger, SESSION_RETENTION_MS, type SessionInfo, type SessionStatus } from "@agent-town/shared";

import { parseOmpSession } from "./session-parser";

const log = createLogger("omp:sessions");
const MAX_SESSION_BYTES = 16 * 1024 * 1024;
const MAX_SESSION_FILES = 1_000;
const SAFE_PROFILE_RE = /^(?!\.{1,2}$)[A-Za-z0-9._-]+$/;

export interface OmpDiscoveryOptions {
  sessionsDir?: string;
  nowMs?: number;
}

export interface OmpSessionCandidate {
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

export function getOmpAgentDir(): string {
  if (process.env.PI_CODING_AGENT_DIR) return process.env.PI_CODING_AGENT_DIR;
  const profile = process.env.OMP_PROFILE;
  if (profile && SAFE_PROFILE_RE.test(profile)) return join(homedir(), ".omp", "profiles", profile, "agent");
  return join(homedir(), ".omp", "agent");
}

export function getOmpSessionsDir(): string {
  return join(getOmpAgentDir(), "sessions");
}

export function clearOmpSessionCache(): void {
  fileCache.clear();
  sessionPaths.clear();
  sessionCreatedAt.clear();
}

export async function discoverOmpSessions(options: OmpDiscoveryOptions = {}): Promise<SessionInfo[]> {
  const sessionsDir = options.sessionsDir ?? getOmpSessionsDir();
  const nowMs = options.nowMs ?? Date.now();
  const paths = await findOmpSessionFiles(sessionsDir);
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
        const parsed = parseOmpSession(await Bun.file(path).text());
        cached = {
          fingerprint,
          session: parsed ? sessionFromParsed(parsed, metadata.mtimeMs, nowMs) : null,
          createdAtMs: parsed?.header.timestamp
            ? Date.parse(parsed.header.timestamp)
            : metadata.birthtimeMs || metadata.mtimeMs,
        };
        fileCache.set(path, cached);
      }
      if (!cached.session) continue;
      const session = { ...cached.session };
      if (!isLifecycleStatus(session.status)) session.status = detectStatus(session.lastActivity, nowMs);
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

export async function findOmpSessionCandidates(sessionsDir = getOmpSessionsDir()): Promise<OmpSessionCandidate[]> {
  const sessions = await discoverOmpSessions({ sessionsDir });
  return sessions.map((session) => ({
    id: session.sessionId,
    cwd: session.cwd,
    createdAtMs: sessionCreatedAt.get(session.sessionId) ?? Date.parse(session.lastActivity),
  }));
}

export async function findOmpSessionPath(sessionId: string, sessionsDir = getOmpSessionsDir()): Promise<string | null> {
  if (!sessionId) return null;
  const cachedPath = sessionPaths.get(sessionId);
  if (cachedPath && isContainedSessionPath(cachedPath, sessionsDir) && (await Bun.file(cachedPath).exists())) {
    return cachedPath;
  }

  for (const path of await findOmpSessionFiles(sessionsDir)) {
    try {
      if (parseOmpSession(await Bun.file(path).text())?.header.id === sessionId) return path;
    } catch (err) {
      log.debug(`session lookup skipped ${basename(path)}: ${formatError(err)}`);
    }
  }
  return null;
}

export async function deleteOmpSessionData(sessionId: string, sessionsDir = getOmpSessionsDir()): Promise<boolean> {
  const path = await findOmpSessionPath(sessionId, sessionsDir);
  if (!path || !isContainedSessionPath(path, sessionsDir)) return false;
  const artifactDir = path.slice(0, -".jsonl".length);
  try {
    await rm(path);
    await rm(artifactDir, { recursive: true, force: true });
    fileCache.delete(path);
    sessionPaths.delete(sessionId);
    sessionCreatedAt.delete(sessionId);
    return true;
  } catch (err) {
    log.warn(`session delete failed: session=${sessionId.slice(0, 8)} error=${formatError(err)}`);
    return false;
  }
}

async function findOmpSessionFiles(sessionsDir: string): Promise<string[]> {
  const paths: string[] = [];
  for (const bucket of await safeReadDir(sessionsDir)) {
    if (paths.length >= MAX_SESSION_FILES) break;
    if (!bucket.isDirectory()) continue;
    const bucketPath = join(sessionsDir, bucket.name);
    for (const entry of await safeReadDir(bucketPath)) {
      if (paths.length >= MAX_SESSION_FILES) break;
      if (entry.isFile() && entry.name.endsWith(".jsonl")) paths.push(join(bucketPath, entry.name));
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
  parsed: NonNullable<ReturnType<typeof parseOmpSession>>,
  mtimeMs: number,
  nowMs: number,
): SessionInfo {
  const messages = parsed.messages;
  const last = messages.at(-1);
  const lastAssistant = findLastItem(messages, (message) => message.role === "assistant" && Boolean(message.content));
  const lastActivity = last && Date.parse(last.timestamp) > 0 ? last.timestamp : latestRecordTimestamp(parsed, mtimeMs);
  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  for (const message of messages) {
    totalInputTokens += message.tokenUsage?.inputTokens ?? 0;
    totalOutputTokens += message.tokenUsage?.outputTokens ?? 0;
  }
  const model = findLastItem(messages, (message) => Boolean(message.model))?.model || parsed.header.model;

  return {
    sessionId: parsed.header.id,
    agentType: "omp",
    slug: parsed.title.slice(0, 100),
    projectPath: parsed.header.cwd,
    projectName: basename(parsed.header.cwd),
    gitBranch: stringValue(parsed.header.gitBranch) || stringValue(parsed.header.git_branch),
    status: parsed.lifecycleStatus ?? detectStatus(lastActivity, nowMs),
    lastActivity,
    lastMessage: last?.content.slice(0, 120) ?? "",
    lastAssistantMessage: lastAssistant?.content,
    cwd: parsed.header.cwd,
    model,
    version: parsed.header.version ? String(parsed.header.version) : undefined,
    totalInputTokens: totalInputTokens || undefined,
    totalOutputTokens: totalOutputTokens || undefined,
    contextTokens: findLastItem(messages, (message) => Boolean(message.tokenUsage?.inputTokens))?.tokenUsage
      ?.inputTokens,
  };
}

function latestRecordTimestamp(parsed: NonNullable<ReturnType<typeof parseOmpSession>>, mtimeMs: number): string {
  for (let index = parsed.activeRecords.length - 1; index >= 0; index--) {
    const timestamp = timestampValue(parsed.activeRecords[index].timestamp);
    if (timestamp) return timestamp;
  }
  return new Date(mtimeMs).toISOString();
}

function timestampValue(value: unknown): string | undefined {
  if (typeof value === "string" && !Number.isNaN(Date.parse(value))) return new Date(value).toISOString();
  if (typeof value === "number" && Number.isFinite(value)) {
    return new Date(value < 10_000_000_000 ? value * 1000 : value).toISOString();
  }
  return undefined;
}

function detectStatus(lastActivity: string, nowMs: number): SessionStatus {
  const age = nowMs - Date.parse(lastActivity);
  if (age < 30_000) return "working";
  if (age < 60_000) return "awaiting_input";
  return "idle";
}

function isLifecycleStatus(status: SessionStatus): boolean {
  return status === "done" || status === "error" || status === "exited" || status === "working";
}

function isContainedSessionPath(path: string, sessionsDir: string): boolean {
  const child = relative(sessionsDir, path);
  return child !== "" && !child.startsWith("..") && !isAbsolute(child) && path.endsWith(".jsonl");
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function findLastItem<T>(items: T[], predicate: (item: T) => boolean): T | undefined {
  for (let index = items.length - 1; index >= 0; index--) {
    const item = items[index];
    if (predicate(item)) return item;
  }
  return undefined;
}
