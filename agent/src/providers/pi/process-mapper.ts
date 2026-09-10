import type { AgentProcess } from "../types";
import { findPiSessionCandidates, type PiSessionCandidate } from "./session-discovery";

const PROCESS_MATCH_WINDOW_MS = 2 * 60 * 1000;
const SAFE_SESSION_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export function filterPiProcesses(processes: AgentProcess[]): AgentProcess[] {
  return processes.filter((process) => isPiCommand(process.args));
}

export function extractPiSessionIdFromArgs(args: string): string | undefined {
  if (!isPiCommand(args)) return undefined;
  const tokens = tokenize(args);
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index];
    let value: string | undefined;
    if (token === "--session" || token === "--session-id") value = tokens[index + 1];
    else if (token.startsWith("--session=")) value = token.slice("--session=".length);
    else if (token.startsWith("--session-id=")) value = token.slice("--session-id=".length);
    if (value && SAFE_SESSION_ID_RE.test(value)) return value;
  }
  return undefined;
}

export function matchPiSessionByStartTime(
  candidates: PiSessionCandidate[],
  cwd: string,
  processStartMs: number,
  claimedIds: Set<string>,
): string | undefined {
  return candidates
    .filter(
      (candidate) =>
        candidate.cwd === cwd &&
        !claimedIds.has(candidate.id) &&
        Math.abs(candidate.createdAtMs - processStartMs) <= PROCESS_MATCH_WINDOW_MS,
    )
    .sort((a, b) => Math.abs(a.createdAtMs - processStartMs) - Math.abs(b.createdAtMs - processStartMs))[0]?.id;
}

export async function matchPiProcessToSession(
  cwd: string,
  processStartMs: number,
  claimedIds: Set<string>,
): Promise<string | undefined> {
  return matchPiSessionByStartTime(await findPiSessionCandidates(), cwd, processStartMs, claimedIds);
}

function isPiCommand(args: string): boolean {
  const tokens = tokenize(args);
  if (tokens.length === 0) return false;
  const executable = basename(tokens[0]);
  if (executable === "pi") return true;
  if (executable === "env" && basename(tokens[1] ?? "") === "pi") return true;
  if ((executable === "node" || executable === "bun") && tokens[1]) {
    const script = tokens[1].replace(/\\/g, "/");
    return script.includes("/pi-coding-agent/") && /\/(?:cli|pi)\.(?:js|mjs|cjs|ts)$/.test(script);
  }
  return false;
}

function tokenize(args: string): string[] {
  return args.trim().split(/\s+/).filter(Boolean);
}

function basename(path: string): string {
  return path.replace(/\\/g, "/").split("/").at(-1) ?? path;
}
