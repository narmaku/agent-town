import type { AgentProcess } from "../types";
import { findOmpSessionCandidates, type OmpSessionCandidate } from "./session-discovery";

const PROCESS_MATCH_WINDOW_MS = 2 * 60 * 1000;
const SAFE_SESSION_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export function filterOmpProcesses(processes: AgentProcess[]): AgentProcess[] {
  return processes.filter((process) => isOmpCommand(process.args));
}

export function extractOmpSessionIdFromArgs(args: string): string | undefined {
  if (!isOmpCommand(args)) return undefined;
  const tokens = tokenize(args);
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index];
    let value: string | undefined;
    if (token === "--resume" || token === "-r" || token === "--session") value = tokens[index + 1];
    else if (token.startsWith("--resume=")) value = token.slice("--resume=".length);
    else if (token.startsWith("-r=")) value = token.slice("-r=".length);
    else if (token.startsWith("--session=")) value = token.slice("--session=".length);
    if (value && isSafeSessionId(value)) return value;
  }
  return undefined;
}

export function matchOmpSessionByStartTime(
  candidates: OmpSessionCandidate[],
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

export async function matchOmpProcessToSession(
  cwd: string,
  processStartMs: number,
  claimedIds: Set<string>,
): Promise<string | undefined> {
  return matchOmpSessionByStartTime(await findOmpSessionCandidates(), cwd, processStartMs, claimedIds);
}

function isOmpCommand(args: string): boolean {
  const tokens = tokenize(args);
  if (tokens.length === 0) return false;
  const executable = basename(tokens[0]);
  if (executable === "omp") return true;
  if (executable === "env" && basename(tokens[1] ?? "") === "omp") return true;
  if ((executable === "node" || executable === "bun") && tokens[1]) {
    const script = tokens[1].replace(/\\/g, "/");
    const isOmpPackage = script.includes("/oh-my-pi/") || script.includes("/@oh-my-pi/pi-coding-agent/");
    return isOmpPackage && /\/(?:cli|omp)\.(?:js|mjs|cjs|ts)$/.test(script);
  }
  return false;
}

function isSafeSessionId(value: string): boolean {
  return SAFE_SESSION_ID_RE.test(value) && !value.includes("..");
}

function tokenize(args: string): string[] {
  return args.trim().split(/\s+/).filter(Boolean);
}

function basename(path: string): string {
  return path.replace(/\\/g, "/").split("/").at(-1) ?? path;
}
