import { readdir, stat, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { createLogger, SESSION_RETENTION_MS, type SessionInfo, type SessionStatus } from "@agent-town/shared";

const log = createLogger("claude:sessions");

const CLAUDE_PROJECTS_DIR = join(homedir(), ".claude", "projects");

const LAST_LINES_LIMIT = 200;

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
    usage?: {
      input_tokens?: number;
      output_tokens?: number;
      cache_creation_input_tokens?: number;
      cache_read_input_tokens?: number;
    };
  };
  toolUseResult?: string;
}

function detectClaudeStatus(lastModifiedMs: number): SessionStatus {
  const age = Date.now() - lastModifiedMs;

  if (age < 30_000) return "working";
  if (age < 60_000) return "awaiting_input";
  if (age < 10 * 60 * 1000) return "idle";
  return "done";
}

/** Discover Claude Code sessions by scanning JSONL files in ~/.claude/projects/. */
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

        if (Date.now() - jsonlStat.mtimeMs > SESSION_RETENTION_MS) continue;

        const session = await parseClaudeSessionFromJsonl(jsonlPath, jsonlStat.mtimeMs);
        if (session) sessions.push(session);
      }
    }
  } catch (err) {
    log.debug(`discoverClaudeSessions: ${err instanceof Error ? err.message : String(err)}`);
  }

  return sessions;
}

async function parseClaudeSessionFromJsonl(jsonlPath: string, mtimeMs: number): Promise<SessionInfo | null> {
  try {
    const text = await Bun.file(jsonlPath).text();
    const lines = text.trim().split("\n");
    const lastLines = lines.slice(-LAST_LINES_LIMIT);
    if (lastLines.length === 0) return null;

    let lastEntry: ClaudeJsonlEntry | null = null;
    for (let i = lastLines.length - 1; i >= 0; i--) {
      try {
        const entry: ClaudeJsonlEntry = JSON.parse(lastLines[i]);
        if ((entry.type === "user" || entry.type === "assistant") && entry.cwd) {
          lastEntry = entry;
          break;
        }
      } catch (_err) {
        // skip malformed JSONL line
      }
    }
    if (!lastEntry) return null;

    // Find first entry with cwd (project root) and aggregate token usage
    let projectRoot = lastEntry.cwd;
    let totalInputTokens = 0;
    let totalOutputTokens = 0;
    const limit = Math.min(lines.length, 20);
    for (let i = 0; i < limit; i++) {
      if (!lines[i].trim()) continue;
      try {
        const entry: ClaudeJsonlEntry = JSON.parse(lines[i]);
        if (entry.cwd && projectRoot === lastEntry.cwd) {
          projectRoot = entry.cwd;
        }
      } catch (_err) {
        // skip malformed JSONL line
      }
    }

    // Aggregate token usage from all lines and find last context size
    interface UsageFields {
      input_tokens?: number;
      output_tokens?: number;
      cache_creation_input_tokens?: number;
      cache_read_input_tokens?: number;
    }
    let lastContextTokens = 0;
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const entry = JSON.parse(line) as { message?: { usage?: UsageFields } };
        const usage = entry.message?.usage;
        if (usage) {
          if (typeof usage.input_tokens === "number") totalInputTokens += usage.input_tokens;
          if (typeof usage.output_tokens === "number") totalOutputTokens += usage.output_tokens;
          // Context = all input tokens sent on this turn (uncached + cache creation + cache read)
          const ctx =
            (usage.input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0);
          if (ctx > 0) lastContextTokens = ctx;
        }
      } catch (_err) {
        // skip malformed JSONL line
      }
    }

    const model = lastEntry.message?.model;

    return {
      sessionId: lastEntry.sessionId,
      agentType: "claude-code",
      slug: lastEntry.slug || lastEntry.sessionId.slice(0, 8),
      projectPath: projectRoot,
      projectName: basename(projectRoot),
      gitBranch: lastEntry.gitBranch && lastEntry.gitBranch !== "HEAD" ? lastEntry.gitBranch : "",
      status: detectClaudeStatus(mtimeMs),
      lastActivity: lastEntry.timestamp || new Date(mtimeMs).toISOString(),
      lastMessage: summarizeLastMessage(lastEntry),
      cwd: lastEntry.cwd,
      model,
      version: lastEntry.version,
      totalInputTokens: totalInputTokens > 0 ? totalInputTokens : undefined,
      totalOutputTokens: totalOutputTokens > 0 ? totalOutputTokens : undefined,
      contextTokens: lastContextTokens > 0 ? lastContextTokens : undefined,
    };
  } catch (err) {
    log.debug(`parseClaudeSession: ${err instanceof Error ? err.message : String(err)}`);
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
      } catch (_err) {
        // not in this directory, continue searching
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

export { CLAUDE_PROJECTS_DIR, parseClaudeSessionFromJsonl as parseClaudeSession };
