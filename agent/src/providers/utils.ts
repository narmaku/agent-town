import { createLogger } from "@agent-town/shared";
import type { AgentProcess } from "./types";

const log = createLogger("providers:utils");

/** Check if a binary is available on the system PATH. */
export async function isBinaryAvailable(binary: string): Promise<boolean> {
  try {
    const proc = Bun.spawn(["which", binary], { stdout: "pipe", stderr: "ignore" });
    await proc.exited;
    return proc.exitCode === 0;
  } catch (err) {
    log.debug(`isBinaryAvailable(${binary}): ${err instanceof Error ? err.message : String(err)}`);
    return false;
  }
}

/** Extract the binary name from the first argument of a process args string. */
export function extractBinaryName(args: string): string | undefined {
  return args.split("/").pop()?.split(" ")[0];
}

/** Filter processes to only those whose binary name matches. */
export function filterProcessesByBinary(processes: AgentProcess[], binaryName: string): AgentProcess[] {
  return processes.filter((p) => extractBinaryName(p.args) === binaryName);
}
