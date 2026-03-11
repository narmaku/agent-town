import { readdir, stat } from "node:fs/promises";
import { join, basename } from "node:path";
import { homedir } from "node:os";
import type { SessionInfo, SessionStatus } from "@agent-town/shared";

const CLAUDE_PROJECTS_DIR = join(homedir(), ".claude", "projects");

// How long (ms) since last JSONL write before a session is considered idle
const IDLE_THRESHOLD_MS = 10 * 60 * 1000; // 10 minutes

// How long (ms) since last tool_use before we consider the agent might be
// waiting for user permission (tool calls can take a while to execute)
const PERMISSION_WAIT_THRESHOLD_MS = 2 * 60 * 1000; // 2 minutes

// How long (ms) since assistant text before we assume it's waiting for user
const USER_INPUT_WAIT_THRESHOLD_MS = 60 * 1000; // 1 minute

interface JsonlEntry {
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

function detectStatus(lastEntry: JsonlEntry, lastModifiedMs: number): SessionStatus {
  // Age = time since the JSONL file was last modified (written to).
  // During active work, entries are appended every few seconds.
  const age = Date.now() - lastModifiedMs;

  // If the file was modified very recently (< 30s), the session is actively running
  if (age < 30_000) {
    return "working";
  }

  // If the last entry is from the user (tool_result or typed message),
  // the assistant should be responding
  if (lastEntry.type === "user") {
    // Still within idle threshold — assistant is probably thinking/generating
    return age < IDLE_THRESHOLD_MS ? "working" : "idle";
  }

  // If the last entry is from the assistant
  if (lastEntry.type === "assistant" && lastEntry.message?.content) {
    const content = lastEntry.message.content;
    if (Array.isArray(content)) {
      const hasToolUse = content.some(
        (block: { type?: string }) => block.type === "tool_use"
      );
      if (hasToolUse) {
        // Assistant made a tool call. The tool is either:
        // - Still executing (working) — age < 2min
        // - Waiting for user permission (needs_attention) — age > 2min
        // - Stale (idle) — age > 10min
        if (age < PERMISSION_WAIT_THRESHOLD_MS) return "working";
        if (age < IDLE_THRESHOLD_MS) return "needs_attention";
        return "idle";
      }
      const hasText = content.some(
        (block: { type?: string }) => block.type === "text"
      );
      if (hasText) {
        // Assistant sent a text response — waiting for user to reply
        if (age < USER_INPUT_WAIT_THRESHOLD_MS) return "working";
        if (age < IDLE_THRESHOLD_MS) return "needs_attention";
        return "idle";
      }
    }
  }

  return age < IDLE_THRESHOLD_MS ? "idle" : "done";
}

function summarizeLastMessage(entry: JsonlEntry): string {
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

async function readFirstLine(filePath: string): Promise<string | null> {
  const file = Bun.file(filePath);
  const text = await file.text();
  const newlineIdx = text.indexOf("\n");
  if (newlineIdx === -1) return text.trim() || null;
  return text.slice(0, newlineIdx).trim() || null;
}

async function readLastLines(filePath: string, count: number): Promise<string[]> {
  const file = Bun.file(filePath);
  const text = await file.text();
  const lines = text.trim().split("\n");
  return lines.slice(-count);
}

function extractFullAssistantText(entry: JsonlEntry): string | undefined {
  if (entry.type !== "assistant") return undefined;
  const content = entry.message?.content;
  if (!content || !Array.isArray(content)) return undefined;

  const textBlocks: string[] = [];
  for (const block of content) {
    const b = block as { type: string; text?: string; name?: string };
    if (b.type === "text" && b.text) {
      textBlocks.push(b.text);
    }
  }
  return textBlocks.length > 0 ? textBlocks.join("\n\n") : undefined;
}

/**
 * Find the last assistant message with text content by scanning
 * the last N lines of the JSONL file backward.
 */
function findLastAssistantText(lines: string[]): string | undefined {
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const entry: JsonlEntry = JSON.parse(lines[i]);
      const text = extractFullAssistantText(entry);
      if (text) return text;
    } catch {
      continue;
    }
  }
  return undefined;
}

export async function parseSession(jsonlPath: string): Promise<SessionInfo | null> {
  try {
    const fileStat = await stat(jsonlPath);
    // Read more lines to find the last assistant text message
    const lastLines = await readLastLines(jsonlPath, 20);
    if (lastLines.length === 0) return null;

    // Find the last real entry (skip non-standard types like "last-prompt", "summary")
    let lastEntry: JsonlEntry | null = null;
    for (let i = lastLines.length - 1; i >= 0; i--) {
      try {
        const entry: JsonlEntry = JSON.parse(lastLines[i]);
        if ((entry.type === "user" || entry.type === "assistant") && entry.cwd) {
          lastEntry = entry;
          break;
        }
      } catch {
        continue;
      }
    }
    if (!lastEntry) return null;

    // Find the last full assistant text message
    const lastAssistantMessage = findLastAssistantText(lastLines);

    // Read the very first line to get the original cwd (project root)
    const firstLineStr = await readFirstLine(jsonlPath);
    const firstEntry: JsonlEntry | null = firstLineStr
      ? JSON.parse(firstLineStr)
      : null;

    // Use the first entry's cwd as the project root — it's the actual
    // filesystem path, not the mangled directory name
    const projectRoot = firstEntry?.cwd || lastEntry.cwd;
    const projectName = basename(projectRoot);

    return {
      sessionId: lastEntry.sessionId,
      slug: lastEntry.slug || lastEntry.sessionId.slice(0, 8),
      projectPath: projectRoot,
      projectName,
      gitBranch:
        lastEntry.gitBranch && lastEntry.gitBranch !== "HEAD"
          ? lastEntry.gitBranch
          : "",
      status: detectStatus(lastEntry, fileStat.mtimeMs),
      lastActivity:
        lastEntry.timestamp || new Date(fileStat.mtimeMs).toISOString(),
      lastMessage: summarizeLastMessage(lastEntry),
      lastAssistantMessage,
      cwd: lastEntry.cwd,
      model: firstEntry?.message?.model || lastEntry.message?.model,
      version: lastEntry.version,
    };
  } catch {
    return null;
  }
}

export async function discoverSessions(): Promise<SessionInfo[]> {
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

        // Only include sessions modified in the last 24 hours
        const ageMs = Date.now() - jsonlStat.mtimeMs;
        if (ageMs > 24 * 60 * 60 * 1000) continue;

        const session = await parseSession(jsonlPath);
        if (session) {
          sessions.push(session);
        }
      }
    }
  } catch {
    // ~/.claude/projects might not exist
  }

  return sessions;
}
