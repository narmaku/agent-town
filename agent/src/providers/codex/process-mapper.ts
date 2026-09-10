import type { AgentProcess } from "../types";
import { discoverCodexSessions } from "./session-discovery";

const UUID_PATTERN = "[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}";
const RESUME_RE = new RegExp(`(?:^|\\s)resume\\s+(${UUID_PATTERN})(?:\\s|$)`, "i");
const PROCESS_MATCH_WINDOW_MS = 2 * 60 * 1000;

export interface CodexSessionCandidate {
  id: string;
  cwd: string;
  createdAtMs: number;
  isSubagent: boolean;
}

export function filterCodexProcesses(processes: AgentProcess[]): AgentProcess[] {
  return processes.filter((process) => isCodexCommand(process.args));
}

export function extractCodexSessionIdFromArgs(args: string): string | undefined {
  if (!isCodexCommand(args)) return undefined;
  return args.match(RESUME_RE)?.[1];
}

export function matchCodexSessionByStartTime(
  candidates: CodexSessionCandidate[],
  cwd: string,
  processStartMs: number,
  claimedIds: Set<string>,
): string | undefined {
  return candidates
    .filter(
      (candidate) =>
        candidate.cwd === cwd &&
        !candidate.isSubagent &&
        !claimedIds.has(candidate.id) &&
        Math.abs(candidate.createdAtMs - processStartMs) <= PROCESS_MATCH_WINDOW_MS,
    )
    .sort((a, b) => Math.abs(a.createdAtMs - processStartMs) - Math.abs(b.createdAtMs - processStartMs))[0]?.id;
}

export async function findCodexSessionCandidates(): Promise<CodexSessionCandidate[]> {
  const sessions = await discoverCodexSessions();
  return sessions.map((session) => ({
    id: session.sessionId,
    cwd: session.cwd,
    createdAtMs: Date.parse(session.lastActivity),
    isSubagent: false,
  }));
}

function isCodexCommand(args: string): boolean {
  const tokens = args.trim().split(/\s+/);
  if (tokens.length === 0) return false;
  const executable = basename(tokens[0]);
  if (executable === "codex") return true;
  if ((executable === "node" || executable === "bun") && tokens[1]) {
    const script = basename(tokens[1]);
    return script === "codex" || script === "codex.js";
  }
  return false;
}

function basename(path: string): string {
  return path.replace(/\\/g, "/").split("/").at(-1) ?? path;
}
