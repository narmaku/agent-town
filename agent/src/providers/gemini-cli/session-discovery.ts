import { readdir, stat, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { createLogger, SESSION_RETENTION_MS, type SessionInfo, type SessionStatus } from "@agent-town/shared";

const log = createLogger("gemini:sessions");

/**
 * Gemini CLI stores sessions in ~/.gemini/tmp/<project_hash>/chats/
 * Each session is a JSON file named session-<datetime>-<short_hash>.json
 *
 * The JSON structure contains:
 * - sessionId: UUID
 * - projectHash: string
 * - startTime: ISO timestamp
 * - lastUpdated: ISO timestamp
 * - messages: Array of message objects
 *
 * Project-to-directory mapping is stored in ~/.gemini/projects.json
 */

const GEMINI_BASE_DIR = join(homedir(), ".gemini");
const GEMINI_TMP_DIR = join(GEMINI_BASE_DIR, "tmp");
const GEMINI_PROJECTS_FILE = join(GEMINI_BASE_DIR, "projects.json");

// ---------------------------------------------------------------------------
// Session cache — avoids re-reading/re-parsing unchanged JSON files
// ---------------------------------------------------------------------------

interface CachedGeminiSession {
  mtimeMs: number;
  session: SessionInfo;
}

const geminiSessionCache = new Map<string, CachedGeminiSession>();

/** Clear the entire session cache (exported for testing). */
export function clearGeminiSessionCache(): void {
  geminiSessionCache.clear();
}

/** Return the number of entries in the session cache (exported for testing). */
export function getGeminiSessionCacheSize(): number {
  return geminiSessionCache.size;
}

/** Get a cached session entry by file path (exported for testing). */
export function getCachedGeminiSession(filePath: string): CachedGeminiSession | undefined {
  return geminiSessionCache.get(filePath);
}

/** Set a cached session entry by file path (exported for testing). */
export function setCachedGeminiSession(filePath: string, entry: CachedGeminiSession): void {
  geminiSessionCache.set(filePath, entry);
}

/** Prune cache entries whose file paths are not in the given active set. */
export function pruneGeminiSessionCache(activeFiles: Set<string>): void {
  for (const key of geminiSessionCache.keys()) {
    if (!activeFiles.has(key)) {
      geminiSessionCache.delete(key);
    }
  }
}

/** Shape of a Gemini CLI session file. */
export interface GeminiSessionFile {
  sessionId: string;
  projectHash: string;
  startTime: string;
  lastUpdated: string;
  messages: GeminiMessage[];
}

export interface GeminiMessage {
  id: string;
  timestamp: string;
  type: "user" | "gemini" | "info";
  content: unknown; // string or array of { text: string }
  displayContent?: Array<{ text: string }>;
  thoughts?: GeminiThought[];
  tokens?: GeminiTokens;
  model?: string;
  toolCalls?: GeminiToolCall[];
}

interface GeminiThought {
  subject: string;
  description: string;
  timestamp: string;
}

interface GeminiTokens {
  input: number;
  output: number;
  cached: number;
  thoughts: number;
  tool: number;
  total: number;
}

export interface GeminiToolCall {
  id: string;
  name: string;
  args: Record<string, unknown>;
  result?: Array<{ functionResponse: { id: string; name: string; response: { output: string } } }>;
  status: string;
  timestamp: string;
  resultDisplay?: string;
  displayName?: string;
  description?: string;
}

/** Map of project paths to their project hashes from ~/.gemini/projects.json */
interface ProjectsMapping {
  projects: Record<string, string>;
}

function detectGeminiStatus(lastUpdatedMs: number): SessionStatus {
  const age = Date.now() - lastUpdatedMs;

  if (age < 30_000) return "working";
  if (age < 60_000) return "awaiting_input";
  if (age < 10 * 60 * 1000) return "idle";
  return "done";
}

/** Load the projects.json mapping file. Returns a reverse map: hash -> path. */
async function loadProjectsMapping(): Promise<Map<string, string>> {
  const reverseMap = new Map<string, string>();
  try {
    const text = await Bun.file(GEMINI_PROJECTS_FILE).text();
    const mapping: ProjectsMapping = JSON.parse(text);
    for (const [projectPath, hash] of Object.entries(mapping.projects)) {
      reverseMap.set(hash, projectPath);
    }
  } catch (err) {
    log.debug(`loadProjectsMapping: ${err instanceof Error ? err.message : String(err)}`);
  }
  return reverseMap;
}

/** Try to resolve a project path from a .project_root file in the tmp dir. */
async function readProjectRoot(projectHashDir: string): Promise<string | undefined> {
  try {
    const rootFile = join(projectHashDir, ".project_root");
    const text = await Bun.file(rootFile).text();
    return text.trim();
  } catch (_err) {
    return undefined;
  }
}

/** Discover Gemini CLI sessions by scanning ~/.gemini/tmp/{project_hash}/chats/. */
export async function discoverGeminiSessions(): Promise<SessionInfo[]> {
  const sessions: SessionInfo[] = [];
  const activeFiles = new Set<string>();

  try {
    const projectsMap = await loadProjectsMapping();
    const tmpDirs = await readdir(GEMINI_TMP_DIR);

    for (const projectHash of tmpDirs) {
      const projectHashDir = join(GEMINI_TMP_DIR, projectHash);
      const dirStat = await stat(projectHashDir);
      if (!dirStat.isDirectory()) continue;

      const chatsDir = join(projectHashDir, "chats");
      let chatFiles: string[];
      try {
        chatFiles = await readdir(chatsDir);
      } catch (_err) {
        continue; // no chats directory
      }

      const jsonFiles = chatFiles.filter((f) => f.endsWith(".json"));

      for (const jsonFile of jsonFiles) {
        const jsonPath = join(chatsDir, jsonFile);
        const fileStat = await stat(jsonPath);

        if (Date.now() - fileStat.mtimeMs > SESSION_RETENTION_MS) continue;

        activeFiles.add(jsonPath);

        // Check cache: if mtime hasn't changed, use cached SessionInfo
        const cached = geminiSessionCache.get(jsonPath);
        if (cached && cached.mtimeMs === fileStat.mtimeMs) {
          sessions.push(cached.session);
          continue;
        }

        // Cache miss or mtime changed — re-parse the file
        const session = await parseGeminiSession(jsonPath, fileStat.mtimeMs, projectHash, projectHashDir, projectsMap);
        if (session) {
          geminiSessionCache.set(jsonPath, { mtimeMs: fileStat.mtimeMs, session });
          sessions.push(session);
        }
      }
    }
  } catch (err) {
    log.debug(`discoverGeminiSessions: ${err instanceof Error ? err.message : String(err)}`);
  }

  // Prune cache entries for deleted or expired files
  pruneGeminiSessionCache(activeFiles);

  return sessions;
}

async function parseGeminiSession(
  jsonPath: string,
  mtimeMs: number,
  projectHash: string,
  projectHashDir: string,
  projectsMap: Map<string, string>,
): Promise<SessionInfo | null> {
  try {
    const text = await Bun.file(jsonPath).text();
    const sessionData: GeminiSessionFile = JSON.parse(text);

    if (!sessionData.sessionId || !sessionData.messages) return null;

    // Resolve project path: try projects.json mapping, then .project_root, then fall back to hash
    let projectPath = projectsMap.get(projectHash) || (await readProjectRoot(projectHashDir)) || projectHash;

    // Try resolving using the full session-level projectHash too
    if (projectPath === projectHash && sessionData.projectHash) {
      const altPath = projectsMap.get(sessionData.projectHash);
      if (altPath) projectPath = altPath;
    }

    const projectName = projectPath.includes("/") ? basename(projectPath) : projectPath;

    // Find the last meaningful message
    const lastMessage = summarizeLastMessage(sessionData.messages);
    const lastUpdatedMs = sessionData.lastUpdated ? new Date(sessionData.lastUpdated).getTime() : mtimeMs;

    // Find model and aggregate tokens from last gemini message
    const lastGeminiMsg = [...sessionData.messages].reverse().find((m) => m.type === "gemini" && m.model);

    // Aggregate token usage and find last context size
    let totalInputTokens = 0;
    let totalOutputTokens = 0;
    let contextTokens = 0;
    for (const msg of sessionData.messages) {
      if (msg.tokens) {
        totalInputTokens += msg.tokens.input ?? 0;
        totalOutputTokens += msg.tokens.output ?? 0;
        const ctx = (msg.tokens.input ?? 0) + (msg.tokens.cached ?? 0);
        if (ctx > 0) contextTokens = ctx;
      }
    }

    return {
      sessionId: sessionData.sessionId,
      agentType: "gemini-cli",
      slug: sessionData.sessionId.slice(0, 8),
      projectPath,
      projectName,
      gitBranch: "",
      status: detectGeminiStatus(lastUpdatedMs),
      lastActivity: sessionData.lastUpdated || new Date(mtimeMs).toISOString(),
      lastMessage,
      cwd: projectPath,
      model: lastGeminiMsg?.model,
      totalInputTokens: totalInputTokens > 0 ? totalInputTokens : undefined,
      totalOutputTokens: totalOutputTokens > 0 ? totalOutputTokens : undefined,
      contextTokens: contextTokens > 0 ? contextTokens : undefined,
    };
  } catch (err) {
    log.debug(`parseGeminiSession: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

function summarizeLastMessage(messages: GeminiMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg.type === "info") continue;

    const text = extractTextContent(msg.content);
    if (text) return text.slice(0, 120);

    if (msg.toolCalls && msg.toolCalls.length > 0) {
      const lastTool = msg.toolCalls[msg.toolCalls.length - 1];
      return `[Tool: ${lastTool.displayName || lastTool.name}]`;
    }
  }
  return "";
}

/** Extract text from a Gemini message content field. */
export function extractTextContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    const texts: string[] = [];
    for (const block of content) {
      const b = block as Record<string, unknown>;
      if (typeof b.text === "string") texts.push(b.text);
    }
    return texts.join("\n\n");
  }
  return "";
}

/** Delete a Gemini CLI session's JSON file. */
export async function deleteGeminiSessionData(sessionId: string): Promise<boolean> {
  try {
    const tmpDirs = await readdir(GEMINI_TMP_DIR);

    for (const projectHash of tmpDirs) {
      const chatsDir = join(GEMINI_TMP_DIR, projectHash, "chats");
      let chatFiles: string[];
      try {
        chatFiles = await readdir(chatsDir);
      } catch (_err) {
        continue;
      }

      for (const chatFile of chatFiles) {
        if (!chatFile.endsWith(".json")) continue;
        const filePath = join(chatsDir, chatFile);
        try {
          const text = await Bun.file(filePath).text();
          const data: { sessionId?: string } = JSON.parse(text);
          if (data.sessionId === sessionId) {
            await unlink(filePath);
            log.info(`deleted Gemini session file: ${filePath}`);
            return true;
          }
        } catch (_err) {
          // skip malformed files
        }
      }
    }
  } catch (err) {
    log.warn(`deleteGeminiSessionData: ${err instanceof Error ? err.message : String(err)}`);
  }
  return false;
}

/** Find session files matching a project directory for process matching. */
export async function findGeminiSessionByDir(directory: string, claimedIds: Set<string>): Promise<string | undefined> {
  try {
    const projectsMap = await loadProjectsMapping();

    // Find the project hash for this directory
    let targetHash: string | undefined;
    for (const [hash, path] of projectsMap) {
      if (path === directory) {
        targetHash = hash;
        break;
      }
    }

    if (!targetHash) {
      // Also try .project_root files
      const tmpDirs = await readdir(GEMINI_TMP_DIR);
      for (const hash of tmpDirs) {
        const projectRoot = await readProjectRoot(join(GEMINI_TMP_DIR, hash));
        if (projectRoot === directory) {
          targetHash = hash;
          break;
        }
      }
    }

    if (!targetHash) return undefined;

    const chatsDir = join(GEMINI_TMP_DIR, targetHash, "chats");
    let chatFiles: string[];
    try {
      chatFiles = await readdir(chatsDir);
    } catch (_err) {
      return undefined;
    }

    // Parse all session files and find the most recently updated unclaimed one
    const candidates: Array<{ sessionId: string; lastUpdated: number }> = [];
    for (const chatFile of chatFiles) {
      if (!chatFile.endsWith(".json")) continue;
      try {
        const text = await Bun.file(join(chatsDir, chatFile)).text();
        const data: GeminiSessionFile = JSON.parse(text);
        if (data.sessionId && !claimedIds.has(data.sessionId)) {
          candidates.push({
            sessionId: data.sessionId,
            lastUpdated: data.lastUpdated ? new Date(data.lastUpdated).getTime() : 0,
          });
        }
      } catch (_err) {
        // skip malformed files
      }
    }

    // Return the most recently updated session
    candidates.sort((a, b) => b.lastUpdated - a.lastUpdated);
    return candidates[0]?.sessionId;
  } catch (err) {
    log.debug(`findGeminiSessionByDir: ${err instanceof Error ? err.message : String(err)}`);
  }
  return undefined;
}

/** Find the session file path for a given session ID. */
export async function findSessionFilePath(sessionId: string): Promise<string | null> {
  try {
    const tmpDirs = await readdir(GEMINI_TMP_DIR);

    for (const projectHash of tmpDirs) {
      const chatsDir = join(GEMINI_TMP_DIR, projectHash, "chats");
      let chatFiles: string[];
      try {
        chatFiles = await readdir(chatsDir);
      } catch (_err) {
        continue;
      }

      for (const chatFile of chatFiles) {
        if (!chatFile.endsWith(".json")) continue;
        // Quick check: session file names contain the short hash of the session ID
        // e.g. session-2026-02-18T01-01-4460d17e.json for sessionId 4460d17e-...
        const shortId = sessionId.slice(0, 8);
        if (chatFile.includes(shortId)) {
          const filePath = join(chatsDir, chatFile);
          try {
            const text = await Bun.file(filePath).text();
            const data: { sessionId?: string } = JSON.parse(text);
            if (data.sessionId === sessionId) return filePath;
          } catch (_err) {
            // continue searching
          }
        }
      }
    }

    // If filename hint didn't work, do a full scan
    return await findSessionFileFullScan(sessionId);
  } catch (err) {
    log.debug(`findSessionFilePath: ${err instanceof Error ? err.message : String(err)}`);
  }
  return null;
}

async function findSessionFileFullScan(sessionId: string): Promise<string | null> {
  try {
    const tmpDirs = await readdir(GEMINI_TMP_DIR);
    for (const projectHash of tmpDirs) {
      const chatsDir = join(GEMINI_TMP_DIR, projectHash, "chats");
      let chatFiles: string[];
      try {
        chatFiles = await readdir(chatsDir);
      } catch (_err) {
        continue;
      }
      for (const chatFile of chatFiles) {
        if (!chatFile.endsWith(".json")) continue;
        const filePath = join(chatsDir, chatFile);
        try {
          const text = await Bun.file(filePath).text();
          const data: { sessionId?: string } = JSON.parse(text);
          if (data.sessionId === sessionId) return filePath;
        } catch (_err) {
          // skip
        }
      }
    }
  } catch (err) {
    log.debug(`findSessionFileFullScan: ${err instanceof Error ? err.message : String(err)}`);
  }
  return null;
}

export { GEMINI_BASE_DIR, GEMINI_TMP_DIR };
