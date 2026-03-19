import { createLogger, type SessionInfo, type SessionMessagesResponse } from "@agent-town/shared";
import type { AgentProcess, AgentProvider, HookEventResult, LaunchOptions, ResumeOptions } from "../types";
import { filterProcessesByBinary, isBinaryAvailable } from "../utils";
import { handleClaudeHookEvent } from "./hook-handler";
import { getClaudeSessionMessages } from "./message-parser";
import { extractClaudeSessionIdFromArgs, findSessionCandidates, matchSessionByBirthTime } from "./process-mapper";
import { deleteClaudeSessionData, discoverClaudeSessions } from "./session-discovery";

const log = createLogger("claude:provider");

export class ClaudeCodeProvider implements AgentProvider {
  readonly type = "claude-code" as const;
  readonly displayName = "Claude Code";
  readonly binaryName = "claude";

  async isAvailable(): Promise<boolean> {
    return isBinaryAvailable(this.binaryName);
  }

  async discoverSessions(): Promise<SessionInfo[]> {
    return discoverClaudeSessions();
  }

  async getSessionMessages(sessionId: string, offset: number, limit: number): Promise<SessionMessagesResponse> {
    return getClaudeSessionMessages(sessionId, offset, limit);
  }

  filterAgentProcesses(processes: AgentProcess[]): AgentProcess[] {
    return filterProcessesByBinary(processes, this.binaryName);
  }

  extractSessionIdFromArgs(args: string): string | undefined {
    return extractClaudeSessionIdFromArgs(args);
  }

  buildLaunchCommand(opts: LaunchOptions): string {
    const parts = ["claude"];
    if (opts.model) parts.push(`--model ${opts.model}`);
    if (opts.autonomous) parts.push("--dangerously-skip-permissions");
    return parts.join(" ");
  }

  buildResumeCommand(opts: ResumeOptions): string {
    const parts = ["claude", "--resume", opts.sessionId];
    if (opts.model) parts.push(`--model ${opts.model}`);
    if (opts.autonomous) parts.push("--dangerously-skip-permissions");
    return parts.join(" ");
  }

  handleHookEvent(payload: unknown): HookEventResult | null {
    return handleClaudeHookEvent(payload);
  }

  async matchProcessToSessionId(
    cwd: string,
    processStartMs: number,
    claimedIds: Set<string>,
  ): Promise<string | undefined> {
    const candidates = await findSessionCandidates(cwd);
    let sessionId = matchSessionByBirthTime(candidates, processStartMs, claimedIds);

    // Fallback: newest unclaimed JSONL in the exact directory
    if (!sessionId && candidates.length > 0) {
      const sorted = [...candidates].sort((a, b) => b.birthtimeMs - a.birthtimeMs);
      sessionId = sorted.find((c) => !claimedIds.has(c.id))?.id;
    }

    return sessionId;
  }

  async deleteSessionData(sessionId: string): Promise<boolean> {
    return deleteClaudeSessionData(sessionId);
  }
}
