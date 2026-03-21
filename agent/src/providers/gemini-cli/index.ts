import type { SessionInfo, SessionMessagesResponse } from "@agent-town/shared";
import type { AgentProcess, AgentProvider, HookEventResult, LaunchOptions, ResumeOptions } from "../types";
import { filterProcessesByBinary, isBinaryAvailable } from "../utils";
import { getGeminiSessionMessages } from "./message-parser";
import { extractGeminiSessionIdFromArgs } from "./process-mapper";
import { deleteGeminiSessionData, discoverGeminiSessions, findGeminiSessionByDir } from "./session-discovery";

export class GeminiCliProvider implements AgentProvider {
  readonly type = "gemini-cli" as const;
  readonly displayName = "Gemini CLI";
  readonly binaryName = "gemini";

  async isAvailable(): Promise<boolean> {
    return isBinaryAvailable(this.binaryName);
  }

  async discoverSessions(): Promise<SessionInfo[]> {
    return discoverGeminiSessions();
  }

  async getSessionMessages(sessionId: string, offset: number, limit: number): Promise<SessionMessagesResponse> {
    return getGeminiSessionMessages(sessionId, offset, limit);
  }

  filterAgentProcesses(processes: AgentProcess[]): AgentProcess[] {
    return filterProcessesByBinary(processes, this.binaryName);
  }

  extractSessionIdFromArgs(args: string): string | undefined {
    return extractGeminiSessionIdFromArgs(args);
  }

  buildLaunchCommand(opts: LaunchOptions): string[] {
    const parts = ["gemini"];
    if (opts.model) parts.push("--model", opts.model);
    if (opts.autonomous) parts.push("--yolo");
    return parts;
  }

  buildResumeCommand(opts: ResumeOptions): string[] {
    const parts = ["gemini", "--resume", opts.sessionId];
    if (opts.model) parts.push("--model", opts.model);
    if (opts.autonomous) parts.push("--yolo");
    return parts;
  }

  handleHookEvent(_payload: unknown): HookEventResult | null {
    // Gemini CLI does not currently support hooks/webhooks for status tracking.
    // Status detection relies on process-based heuristics and file modification times.
    return null;
  }

  async matchProcessToSessionId(
    cwd: string,
    _processStartMs: number,
    claimedIds: Set<string>,
  ): Promise<string | undefined> {
    return findGeminiSessionByDir(cwd, claimedIds);
  }

  async deleteSessionData(sessionId: string): Promise<boolean> {
    return deleteGeminiSessionData(sessionId);
  }
}
