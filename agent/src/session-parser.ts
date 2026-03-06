import { readdir, stat } from "node:fs/promises";
import { join, basename } from "node:path";
import { homedir } from "node:os";
import type { SessionInfo, SessionStatus } from "@agent-town/shared";

const CLAUDE_PROJECTS_DIR = join(homedir(), ".claude", "projects");

// How long (ms) since last activity before a session is considered idle
const IDLE_THRESHOLD_MS = 5 * 60 * 1000; // 5 minutes

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

function extractProjectName(dirName: string): string {
  // Claude Code stores projects as hyphen-separated paths like "-home-nmunoz-development-myproject"
  const parts = dirName.replace(/^-/, "").split("-");
  return parts[parts.length - 1] || dirName;
}

function extractProjectPath(dirName: string): string {
  return "/" + dirName.replace(/^-/, "").replace(/-/g, "/");
}

function detectStatus(lastEntry: JsonlEntry, lastModifiedMs: number): SessionStatus {
  const age = Date.now() - lastModifiedMs;

  // If the last entry is from the user and contains a tool_result, the assistant is working
  if (lastEntry.type === "user" && lastEntry.message?.content) {
    const content = lastEntry.message.content;
    if (Array.isArray(content)) {
      const hasToolResult = content.some(
        (block: { type?: string }) => block.type === "tool_result"
      );
      if (hasToolResult) {
        // Tool result just came in — assistant should be responding
        return age < IDLE_THRESHOLD_MS ? "working" : "idle";
      }
    }
    // User typed something — assistant should respond
    if (typeof content === "string") {
      return age < IDLE_THRESHOLD_MS ? "working" : "idle";
    }
  }

  // If the last entry is from the assistant
  if (lastEntry.type === "assistant" && lastEntry.message?.content) {
    const content = lastEntry.message.content;
    if (Array.isArray(content)) {
      const hasToolUse = content.some(
        (block: { type?: string }) => block.type === "tool_use"
      );
      if (hasToolUse) {
        // Assistant is making tool calls — it's working or waiting for permission
        // If file hasn't been modified in a while, it's likely waiting for user permission
        return age > 10_000 ? "needs_attention" : "working";
      }
      const hasText = content.some(
        (block: { type?: string }) => block.type === "text"
      );
      if (hasText && !hasToolUse) {
        // Assistant sent a text-only response — waiting for user input
        return age < IDLE_THRESHOLD_MS ? "needs_attention" : "idle";
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

async function readLastLines(filePath: string, count: number): Promise<string[]> {
  const file = Bun.file(filePath);
  const text = await file.text();
  const lines = text.trim().split("\n");
  return lines.slice(-count);
}

export async function parseSession(jsonlPath: string): Promise<SessionInfo | null> {
  try {
    const fileStat = await stat(jsonlPath);
    const lastLines = await readLastLines(jsonlPath, 3);
    if (lastLines.length === 0) return null;

    const lastLine = lastLines[lastLines.length - 1];
    const lastEntry: JsonlEntry = JSON.parse(lastLine);

    // Also check an earlier entry for more context
    const firstLine = lastLines[0];
    const firstEntry: JsonlEntry = JSON.parse(firstLine);

    const dirName = basename(jsonlPath.split("/projects/")[1]?.split("/")[0] || "");

    return {
      sessionId: lastEntry.sessionId,
      slug: lastEntry.slug || lastEntry.sessionId.slice(0, 8),
      projectPath: extractProjectPath(dirName),
      projectName: extractProjectName(dirName),
      gitBranch: lastEntry.gitBranch || "",
      status: detectStatus(lastEntry, fileStat.mtimeMs),
      lastActivity: lastEntry.timestamp || new Date(fileStat.mtimeMs).toISOString(),
      lastMessage: summarizeLastMessage(lastEntry),
      cwd: lastEntry.cwd,
      model: firstEntry.message?.model || lastEntry.message?.model,
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
        const fileStat = await stat(jsonlPath);

        // Only include sessions modified in the last 24 hours
        const ageMs = Date.now() - fileStat.mtimeMs;
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
