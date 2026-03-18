import { createLogger, type SessionInfo, type SessionStatus } from "@agent-town/shared";

const log = createLogger("claude:sessions");

/**
 * Session discovery using the Claude Agent SDK.
 *
 * Uses `listSessions()` and `getSessionMessages()` from
 * @anthropic-ai/claude-agent-sdk instead of manually scanning JSONL files.
 */

interface SDKSessionInfo {
  sessionId: string;
  summary: string;
  lastModified: number;
  fileSize?: number;
  customTitle?: string;
  firstPrompt?: string;
  gitBranch?: string;
  cwd?: string;
  tag?: string;
  createdAt?: number;
}

export async function discoverClaudeSessions(): Promise<SessionInfo[]> {
  const sessions: SessionInfo[] = [];

  try {
    const { listSessions } = await import("@anthropic-ai/claude-agent-sdk");
    const sdkSessions: SDKSessionInfo[] = await listSessions();

    const sevenDaysAgoMs = Date.now() - 7 * 24 * 60 * 60 * 1000;

    for (const s of sdkSessions) {
      if (s.lastModified < sevenDaysAgoMs) continue;

      const cwd = s.cwd || "";
      const projectName = cwd.split("/").pop() || "unknown";
      const status = detectClaudeStatus(s.lastModified);

      sessions.push({
        sessionId: s.sessionId,
        agentType: "claude-code",
        slug: s.sessionId.slice(0, 8),
        customName: s.customTitle,
        projectPath: cwd,
        projectName,
        gitBranch: s.gitBranch && s.gitBranch !== "HEAD" ? s.gitBranch : "",
        status,
        lastActivity: new Date(s.lastModified).toISOString(),
        lastMessage: s.summary || s.firstPrompt?.slice(0, 120) || "",
        cwd,
      });
    }
  } catch (err) {
    log.debug(`discoverClaudeSessions: SDK failed: ${err instanceof Error ? err.message : String(err)}`);
    // Fall back to JSONL scanning if SDK not available
    return discoverClaudeSessionsFallback();
  }

  return sessions;
}

function detectClaudeStatus(lastModifiedMs: number): SessionStatus {
  const age = Date.now() - lastModifiedMs;

  if (age < 30_000) return "working";
  if (age < 60_000) return "awaiting_input";
  if (age < 10 * 60 * 1000) return "idle";
  return "done";
}

// --- Fallback: JSONL scanning (if SDK import fails) ---

import { readdir, stat, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join } from "node:path";

const CLAUDE_PROJECTS_DIR = join(homedir(), ".claude", "projects");

export interface ClaudeJsonlEntry {
  type: "user" | "assistant";
  sessionId: string;
  slug?: string;
  cwd: string;
  gitBranch?: string;
  version?: string;
  timestamp: string;
  message: {
    role: string;
    model?: string;
    content?: unknown;
  };
  toolUseResult?: string;
}

async function discoverClaudeSessionsFallback(): Promise<SessionInfo[]> {
  log.info("using JSONL fallback for session discovery");
  const sessions: SessionInfo[] = [];

  try {
    const projectDirs = await readdir(CLAUDE_PROJECTS_DIR);
    const sevenDaysMs = 7 * 24 * 60 * 60 * 1000;

    for (const dir of projectDirs) {
      const projectDir = join(CLAUDE_PROJECTS_DIR, dir);
      const dirStat = await stat(projectDir);
      if (!dirStat.isDirectory()) continue;

      const files = await readdir(projectDir);
      const jsonlFiles = files.filter((f) => f.endsWith(".jsonl"));

      for (const jsonlFile of jsonlFiles) {
        const jsonlPath = join(projectDir, jsonlFile);
        const jsonlStat = await stat(jsonlPath);

        if (Date.now() - jsonlStat.mtimeMs > sevenDaysMs) continue;

        const session = await parseClaudeSessionFromJsonl(jsonlPath, jsonlStat.mtimeMs);
        if (session) sessions.push(session);
      }
    }
  } catch (err) {
    log.debug(`discoverClaudeSessionsFallback: ${err instanceof Error ? err.message : String(err)}`);
  }

  return sessions;
}

async function parseClaudeSessionFromJsonl(jsonlPath: string, mtimeMs: number): Promise<SessionInfo | null> {
  try {
    const text = await Bun.file(jsonlPath).text();
    const lines = text.trim().split("\n");
    const lastLines = lines.slice(-200);
    if (lastLines.length === 0) return null;

    let lastEntry: ClaudeJsonlEntry | null = null;
    for (let i = lastLines.length - 1; i >= 0; i--) {
      try {
        const entry: ClaudeJsonlEntry = JSON.parse(lastLines[i]);
        if ((entry.type === "user" || entry.type === "assistant") && entry.cwd) {
          lastEntry = entry;
          break;
        }
      } catch {}
    }
    if (!lastEntry) return null;

    // Find first entry with cwd (project root)
    let projectRoot = lastEntry.cwd;
    const limit = Math.min(lines.length, 20);
    for (let i = 0; i < limit; i++) {
      if (!lines[i].trim()) continue;
      try {
        const entry: ClaudeJsonlEntry = JSON.parse(lines[i]);
        if (entry.cwd) {
          projectRoot = entry.cwd;
          break;
        }
      } catch {}
    }

    const summary = summarizeLastMessage(lastEntry);

    return {
      sessionId: lastEntry.sessionId,
      agentType: "claude-code",
      slug: lastEntry.slug || lastEntry.sessionId.slice(0, 8),
      projectPath: projectRoot,
      projectName: basename(projectRoot),
      gitBranch: lastEntry.gitBranch && lastEntry.gitBranch !== "HEAD" ? lastEntry.gitBranch : "",
      status: detectClaudeStatus(mtimeMs),
      lastActivity: lastEntry.timestamp || new Date(mtimeMs).toISOString(),
      lastMessage: summary,
      cwd: lastEntry.cwd,
      model: lastEntry.message?.model,
      version: lastEntry.version,
    };
  } catch (err) {
    log.debug(`parseClaudeSessionFromJsonl: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

function summarizeLastMessage(entry: ClaudeJsonlEntry): string {
  const content = entry.message?.content;
  if (!content) return "";
  if (typeof content === "string") return content.slice(0, 120);
  if (Array.isArray(content)) {
    for (const block of content) {
      const b = block as { type: string; text?: string; name?: string };
      if (b.type === "text") return (b.text || "").slice(0, 120);
      if (b.type === "tool_use") return `[Tool: ${b.name}]`;
      if (b.type === "tool_result") return "[Waiting for response...]";
    }
  }
  return "";
}

/** Delete a Claude Code session's JSONL file. */
export async function deleteClaudeSessionData(sessionId: string): Promise<boolean> {
  try {
    const dirs = await readdir(CLAUDE_PROJECTS_DIR);
    for (const dir of dirs) {
      const dirPath = join(CLAUDE_PROJECTS_DIR, dir);
      const dirStat = await stat(dirPath);
      if (!dirStat.isDirectory()) continue;

      const jsonlFile = join(dirPath, `${sessionId}.jsonl`);
      try {
        await stat(jsonlFile);
        await unlink(jsonlFile);
        return true;
      } catch {
        // not in this directory
      }
    }
  } catch (err) {
    log.warn(`deleteClaudeSessionData: ${err instanceof Error ? err.message : String(err)}`);
  }
  return false;
}

export function pathToProjectDir(fsPath: string): string {
  return fsPath.replace(/\//g, "-").replace(/^-/, "-");
}

// Re-export parseSession for tests
export { CLAUDE_PROJECTS_DIR, parseClaudeSessionFromJsonl as parseClaudeSession };
