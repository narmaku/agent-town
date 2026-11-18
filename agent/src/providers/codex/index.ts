import type { SessionInfo, SessionMessagesResponse } from "@agent-town/shared";

import type { AgentProcess, AgentProvider, HookEventResult, LaunchOptions, ResumeOptions } from "../types";
import { isBinaryAvailable } from "../utils";
import { getCodexSessionMessages } from "./message-parser";
import {
  extractCodexSessionIdFromArgs,
  filterCodexProcesses,
  findCodexSessionCandidates,
  matchCodexSessionByStartTime,
} from "./process-mapper";
import { deleteCodexSessionData, discoverCodexSessions } from "./session-discovery";

export class CodexProvider implements AgentProvider {
  readonly type = "codex" as const;
  readonly displayName = "Codex CLI";
  readonly binaryName = "codex";
  readonly terminal = {
    inputMode: "bracketed-paste",
    startupMode: "tui",
    autonomousDisclaimer: false,
  } as const;

  async isAvailable(): Promise<boolean> {
    return isBinaryAvailable(this.binaryName);
  }

  async discoverSessions(): Promise<SessionInfo[]> {
    return discoverCodexSessions();
  }

  async getSessionMessages(sessionId: string, offset: number, limit: number): Promise<SessionMessagesResponse> {
    return getCodexSessionMessages(sessionId, offset, limit);
  }

  filterAgentProcesses(processes: AgentProcess[]): AgentProcess[] {
    return filterCodexProcesses(processes);
  }

  extractSessionIdFromArgs(args: string): string | undefined {
    return extractCodexSessionIdFromArgs(args);
  }

  buildLaunchCommand(options: LaunchOptions): string[] {
    const command = ["codex"];
    if (options.model) command.push("--model", options.model);
    if (options.autonomous) command.push("--dangerously-bypass-approvals-and-sandbox");
    return command;
  }

  buildResumeCommand(options: ResumeOptions): string[] {
    const command = ["codex", "resume", options.sessionId];
    if (options.model) command.push("--model", options.model);
    if (options.autonomous) command.push("--dangerously-bypass-approvals-and-sandbox");
    return command;
  }

  handleHookEvent(_payload: unknown): HookEventResult | null {
    return null;
  }

  async matchProcessToSessionId(
    cwd: string,
    processStartMs: number,
    claimedIds: Set<string>,
  ): Promise<string | undefined> {
    return matchCodexSessionByStartTime(await findCodexSessionCandidates(), cwd, processStartMs, claimedIds);
  }

  async deleteSessionData(sessionId: string): Promise<boolean> {
    return deleteCodexSessionData(sessionId);
  }
}
