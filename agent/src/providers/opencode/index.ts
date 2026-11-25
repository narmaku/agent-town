import { applyPermissionMode } from "../permission-mode";
import type { SessionInfo, SessionMessagesResponse } from "@agent-town/shared";
import type { SearchMessageResult } from "../search";
import type { AgentProcess, AgentProvider, LaunchOptions, ResumeOptions } from "../types";
import { filterProcessesByBinary, isBinaryAvailable } from "../utils";
import { getOpenCodeSessionMessages, searchOpenCodeMessages } from "./message-parser";
import { extractOpenCodeSessionIdFromArgs } from "./process-mapper";
import { deleteOpenCodeSessionData, discoverOpenCodeSessions, findOpenCodeSessionByDir } from "./session-discovery";

export class OpenCodeProvider implements AgentProvider {
  readonly type = "opencode" as const;
  readonly displayName = "OpenCode";
  readonly binaryName = "opencode";
  readonly terminal = {
    inputMode: "bracketed-paste",
    startupMode: "tui",
    autonomousDisclaimer: false,
  } as const;

  async isAvailable(): Promise<boolean> {
    return isBinaryAvailable(this.binaryName);
  }

  async discoverSessions(): Promise<SessionInfo[]> {
    return discoverOpenCodeSessions();
  }

  async getSessionMessages(sessionId: string, offset: number, limit: number): Promise<SessionMessagesResponse> {
    return getOpenCodeSessionMessages(sessionId, offset, limit);
  }

  async searchMessages(query: string, maxResults: number): Promise<SearchMessageResult[]> {
    return searchOpenCodeMessages(query, maxResults);
  }

  filterAgentProcesses(processes: AgentProcess[]): AgentProcess[] {
    return filterProcessesByBinary(processes, this.binaryName);
  }

  extractSessionIdFromArgs(args: string): string | undefined {
    return extractOpenCodeSessionIdFromArgs(args);
  }

  buildLaunchCommand(opts: LaunchOptions): string[] {
    const parts = ["opencode"];
    if (opts.model) parts.push("--model", opts.model);
    return applyPermissionMode(this.type, parts, opts);
  }

  buildResumeCommand(opts: ResumeOptions): string[] {
    const parts = ["opencode", "--session", opts.sessionId];
    if (opts.model) parts.push("--model", opts.model);
    return applyPermissionMode(this.type, parts, opts);
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
