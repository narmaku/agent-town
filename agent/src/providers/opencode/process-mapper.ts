import type { AgentProcess } from "../types";

/** Filter processes to only those running the "opencode" binary. */
export function filterOpenCodeProcesses(processes: AgentProcess[]): AgentProcess[] {
  return processes.filter((p) => {
    const bin = p.args.split("/").pop()?.split(" ")[0];
    return bin === "opencode";
  });
}

/**
 * Extract session ID from OpenCode command args.
 * OpenCode uses `--session <id>` or `-s <id>`.
 */
export function extractOpenCodeSessionIdFromArgs(args: string): string | undefined {
  const match = args.match(/(?:--session|-s)\s+(\S+)/);
  return match?.[1];
}
