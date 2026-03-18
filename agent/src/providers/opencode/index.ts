import type { SessionInfo, SessionMessagesResponse } from "@agent-town/shared";
import type { AgentProcess, AgentProvider, HookEventResult, LaunchOptions, ResumeOptions } from "../types";
import { handleOpenCodeEvent } from "./event-handler";
import { getOpenCodeSessionMessages } from "./message-parser";
import { extractOpenCodeSessionIdFromArgs, filterOpenCodeProcesses } from "./process-mapper";
import { deleteOpenCodeSessionData, discoverOpenCodeSessions, findOpenCodeSessionByDir } from "./session-discovery";

async function isBinaryAvailable(binary: string): Promise<boolean> {
  try {
    const proc = Bun.spawn(["which", binary], { stdout: "pipe", stderr: "pipe" });
    await proc.exited;
    return proc.exitCode === 0;
  } catch {
    return false;
  }
}

export class OpenCodeProvider implements AgentProvider {
  readonly type = "opencode" as const;
  readonly displayName = "OpenCode";
  readonly binaryName = "opencode";

  async isAvailable(): Promise<boolean> {
    return isBinaryAvailable(this.binaryName);
  }

  async discoverSessions(): Promise<SessionInfo[]> {
    return discoverOpenCodeSessions();
  }

  async getSessionMessages(sessionId: string, offset: number, limit: number): Promise<SessionMessagesResponse> {
    return getOpenCodeSessionMessages(sessionId, offset, limit);
  }

  filterAgentProcesses(processes: AgentProcess[]): AgentProcess[] {
    return filterOpenCodeProcesses(processes);
  }

  extractSessionIdFromArgs(args: string): string | undefined {
    return extractOpenCodeSessionIdFromArgs(args);
  }

  buildLaunchCommand(opts: LaunchOptions): string {
    const parts = ["opencode"];
    if (opts.model) parts.push(`--model ${opts.model}`);
    // OpenCode uses config-based permissions, not a CLI flag.
    // Autonomous mode is handled by ensuring opencode.json has permission: "allow".
    return parts.join(" ");
  }

  buildResumeCommand(opts: ResumeOptions): string {
    const parts = ["opencode", "--session", opts.sessionId];
    if (opts.model) parts.push(`--model ${opts.model}`);
    return parts.join(" ");
  }

  handleHookEvent(payload: unknown): HookEventResult | null {
    return handleOpenCodeEvent(payload);
  }

  async matchProcessToSessionId(
    cwd: string,
    _processStartMs: number,
    claimedIds: Set<string>,
  ): Promise<string | undefined> {
    return findOpenCodeSessionByDir(cwd, claimedIds);
  }

  async deleteSessionData(sessionId: string): Promise<boolean> {
    return deleteOpenCodeSessionData(sessionId);
  }
}
