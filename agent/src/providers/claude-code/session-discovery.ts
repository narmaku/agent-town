import { readdir, stat, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { createLogger, type SessionInfo, type SessionStatus } from "@agent-town/shared";

const log = createLogger("claude:sessions");

const CLAUDE_PROJECTS_DIR = join(homedir(), ".claude", "projects");

const IDLE_THRESHOLD_MS = 10 * 60 * 1000; // 10 minutes
const PERMISSION_WAIT_THRESHOLD_MS = 2 * 60 * 1000; // 2 minutes
const USER_INPUT_WAIT_THRESHOLD_MS = 60 * 1000; // 1 minute

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

export function detectStatus(lastEntry: ClaudeJsonlEntry, lastModifiedMs: number): SessionStatus {
  const age = Date.now() - lastModifiedMs;

  if (age < 30_000) {
    return "working";
  }

  if (lastEntry.type === "user") {
    return age < IDLE_THRESHOLD_MS ? "working" : "idle";
  }

  if (lastEntry.type === "assistant" && lastEntry.message?.content) {
    const content = lastEntry.message.content;
    if (Array.isArray(content)) {
      const toolUseBlocks = content.filter((block: { type?: string }) => block.type === "tool_use") as {
        type: string;
        name?: string;
      }[];
      const hasToolUse = toolUseBlocks.length > 0;

      const hasAskUser = toolUseBlocks.some((block) => block.name === "AskUserQuestion");
      if (hasAskUser) {
        return "action_required";
      }

      if (hasToolUse) {
        if (age < PERMISSION_WAIT_THRESHOLD_MS) return "working";
        if (age < IDLE_THRESHOLD_MS) return "awaiting_input";
        return "idle";
      }
      const hasText = content.some((block: { type?: string }) => block.type === "text");
      if (hasText) {
        if (age < USER_INPUT_WAIT_THRESHOLD_MS) return "working";
        if (age < IDLE_THRESHOLD_MS) return "awaiting_input";
        return "idle";
      }
    }
  }

  return age < IDLE_THRESHOLD_MS ? "idle" : "done";
}

function summarizeLastMessage(entry: ClaudeJsonlEntry): string {
  const content = entry.message?.content;
  if (!content) return "";

  if (typeof content === "string") {
    return content.slice(0, 120);
  }

  if (Array.isArray(content)) {
    for (const block of content) {
      if ((block as { type: string; text?: string }).type === "text") {
        return ((block as { text: string }).text || "").slice(0, 120);
      }
      if ((block as { type: string; name?: string }).type === "tool_use") {
        return `[Tool: ${(block as { name: string }).name}]`;
      }
      if ((block as { type: string }).type === "tool_result") {
        return "[Waiting for response...]";
      }
    }
  }
  return "";
}

async function readFirstEntryWithCwd(filePath: string): Promise<ClaudeJsonlEntry | null> {
  const file = Bun.file(filePath);
  const text = await file.text();
  const lines = text.split("\n");
  const limit = Math.min(lines.length, 20);
  for (let i = 0; i < limit; i++) {
    if (!lines[i].trim()) continue;
    try {
      const entry: ClaudeJsonlEntry = JSON.parse(lines[i]);
      if (entry.cwd) return entry;
    } catch {}
  }
  return null;
}

async function readLastLines(filePath: string, count: number): Promise<string[]> {
  const file = Bun.file(filePath);
  const text = await file.text();
  const lines = text.trim().split("\n");
  return lines.slice(-count);
}

function extractFullAssistantText(entry: ClaudeJsonlEntry): string | undefined {
  if (entry.type !== "assistant") return undefined;
  const content = entry.message?.content;
  if (!content || !Array.isArray(content)) return undefined;

  const textBlocks: string[] = [];
  for (const block of content) {
    const b = block as { type: string; text?: string };
    if (b.type === "text" && b.text) {
      textBlocks.push(b.text);
    }
  }
  return textBlocks.length > 0 ? textBlocks.join("\n\n") : undefined;
}

function findLastAssistantText(lines: string[]): string | undefined {
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const entry: ClaudeJsonlEntry = JSON.parse(lines[i]);
      const text = extractFullAssistantText(entry);
      if (text) return text;
    } catch {}
  }
  return undefined;
}

export async function parseClaudeSession(jsonlPath: string): Promise<SessionInfo | null> {
  try {
    const fileStat = await stat(jsonlPath);
    const lastLines = await readLastLines(jsonlPath, 200);
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

    const lastAssistantMessage = findLastAssistantText(lastLines);
    const firstCwdEntry = await readFirstEntryWithCwd(jsonlPath);
    const projectRoot = firstCwdEntry?.cwd || lastEntry.cwd;
    const projectName = basename(projectRoot);

    return {
      sessionId: lastEntry.sessionId,
      agentType: "claude-code",
      slug: lastEntry.slug || lastEntry.sessionId.slice(0, 8),
      projectPath: projectRoot,
      projectName,
      gitBranch: lastEntry.gitBranch && lastEntry.gitBranch !== "HEAD" ? lastEntry.gitBranch : "",
      status: detectStatus(lastEntry, fileStat.mtimeMs),
      lastActivity: lastEntry.timestamp || new Date(fileStat.mtimeMs).toISOString(),
      lastMessage: summarizeLastMessage(lastEntry),
      lastAssistantMessage,
      cwd: lastEntry.cwd,
      model: firstCwdEntry?.message?.model || lastEntry.message?.model,
      version: lastEntry.version,
    };
  } catch (err) {
    log.debug(`parseClaudeSession failed for ${jsonlPath}: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

export async function discoverClaudeSessions(): Promise<SessionInfo[]> {
  const sessions: SessionInfo[] = [];

  try {
    const projectDirs = await readdir(CLAUDE_PROJECTS_DIR);

    for (const dir of projectDirs) {
      const projectDir = join(CLAUDE_PROJECTS_DIR, dir);
      const dirStat = await stat(projectDir);
      if (!dirStat.isDirectory()) continue;

      const files = await readdir(projectDir);
      const jsonlFiles = files.filter((f) => f.endsWith(".jsonl"));

      for (const jsonlFile of jsonlFiles) {
        const jsonlPath = join(projectDir, jsonlFile);
        const jsonlStat = await stat(jsonlPath);

        const ageMs = Date.now() - jsonlStat.mtimeMs;
        if (ageMs > 7 * 24 * 60 * 60 * 1000) continue;

        const session = await parseClaudeSession(jsonlPath);
        if (session) {
          sessions.push(session);
        }
      }
    }
  } catch (err) {
    log.debug(
      `discoverClaudeSessions: projects dir not accessible: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  return sessions;
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
    log.warn(`deleteClaudeSessionData failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  return false;
}

// --- Exported for process-mapper ---

export function pathToProjectDir(fsPath: string): string {
  return fsPath.replace(/\//g, "-").replace(/^-/, "-");
}

export { CLAUDE_PROJECTS_DIR };
