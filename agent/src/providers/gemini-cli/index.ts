import type { SessionInfo, SessionMessagesResponse } from "@agent-town/shared";
import type { SearchMessageResult } from "../search";
import type { AgentProcess, AgentProvider, LaunchOptions, ResumeOptions } from "../types";
import { filterProcessesByBinary, isBinaryAvailable } from "../utils";
import { getGeminiSessionMessages, searchGeminiMessages } from "./message-parser";
import { extractGeminiSessionIdFromArgs } from "./process-mapper";
import { deleteGeminiSessionData, discoverGeminiSessions, findGeminiSessionByDir } from "./session-discovery";

export class GeminiCliProvider implements AgentProvider {
  readonly type = "gemini-cli" as const;
  readonly displayName = "Gemini CLI";
  readonly binaryName = "gemini";
  readonly terminal = {
    inputMode: "bracketed-paste",
    startupMode: "cli-prompt",
    autonomousDisclaimer: true,
  } as const;

  async isAvailable(): Promise<boolean> {
    return isBinaryAvailable(this.binaryName);
  }

  async discoverSessions(): Promise<SessionInfo[]> {
    return discoverGeminiSessions();
  }

  async getSessionMessages(sessionId: string, offset: number, limit: number): Promise<SessionMessagesResponse> {
    return getGeminiSessionMessages(sessionId, offset, limit);
  }

  async searchMessages(query: string, maxResults: number): Promise<SearchMessageResult[]> {
    return searchGeminiMessages(query, maxResults);
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
