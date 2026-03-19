import { readdir, stat } from "node:fs/promises";
import { basename, join } from "node:path";
import { createLogger } from "@agent-town/shared";
import { CLAUDE_PROJECTS_DIR, pathToProjectDir } from "./session-discovery";

const log = createLogger("claude:process-mapper");

/** Extract session ID from `--resume <uuid>` in command args. */
export function extractClaudeSessionIdFromArgs(args: string): string | undefined {
  const match = args.match(/--resume\s+([0-9a-f-]{36})/);
  return match?.[1];
}

export interface SessionCandidate {
  id: string;
  birthtimeMs: number;
}

const BIRTHTIME_MATCH_WINDOW_MS = 120_000; // 2 minutes

/** Get file creation time using system stat (Bun's birthtimeMs returns 0 on Linux). */
async function getBirthtimeMs(filePath: string): Promise<number> {
  try {
    const proc = Bun.spawn(["stat", "-c", "%W", filePath], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const output = await new Response(proc.stdout).text();
    await proc.exited;
    const seconds = parseInt(output.trim(), 10);
    return seconds > 0 ? seconds * 1000 : 0;
  } catch (err) {
    log.debug(`getBirthtimeMs: failed for ${filePath}: ${err instanceof Error ? err.message : String(err)}`);
    return 0;
  }
}

/** Find JSONL session candidates in the exact project directory for the given cwd. */
export async function findSessionCandidates(cwd: string): Promise<SessionCandidate[]> {
  const mangled = pathToProjectDir(cwd);
  const projectDir = join(CLAUDE_PROJECTS_DIR, mangled);

  try {
    const dirStat = await stat(projectDir);
    if (!dirStat.isDirectory()) return [];

    const files = await readdir(projectDir);
    const jsonlFiles = files.filter((f) => f.endsWith(".jsonl"));

    const candidates: SessionCandidate[] = [];
    for (const f of jsonlFiles) {
      const filePath = join(projectDir, f);
      const birthtimeMs = await getBirthtimeMs(filePath);
      candidates.push({
        id: basename(f, ".jsonl"),
        birthtimeMs,
      });
    }
    return candidates;
  } catch (err) {
    log.debug(`findSessionCandidates: failed for cwd=${cwd}: ${err instanceof Error ? err.message : String(err)}`);
    return [];
  }
}

/** Match a session by comparing JSONL birth time to process start time. */
export function matchSessionByBirthTime(
  candidates: SessionCandidate[],
  processStartMs: number,
  claimedIds: Set<string>,
): string | undefined {
  let bestId: string | undefined;
  let bestDiff = Infinity;

  for (const c of candidates) {
    if (claimedIds.has(c.id)) continue;
    const diff = Math.abs(c.birthtimeMs - processStartMs);
    if (diff < BIRTHTIME_MATCH_WINDOW_MS && diff < bestDiff) {
      bestDiff = diff;
      bestId = c.id;
    }
  }

  return bestId;
}
