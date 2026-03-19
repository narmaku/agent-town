import { createLogger, type SessionInfo, type SessionMessagesResponse } from "@agent-town/shared";
import type { AgentProcess, AgentProvider, HookEventResult, LaunchOptions, ResumeOptions } from "../types";
import { filterProcessesByBinary, isBinaryAvailable } from "../utils";
import { handleOpenCodeEvent, isSSEActive, startOpenCodeEventStream } from "./event-handler";
import { getOpenCodeSessionMessages } from "./message-parser";
import { extractOpenCodeSessionIdFromArgs } from "./process-mapper";
import { getOpenCodeClient } from "./sdk-client";
import { deleteOpenCodeSessionData, discoverOpenCodeSessions, findOpenCodeSessionByDir } from "./session-discovery";

const log = createLogger("opencode:provider");

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
    return filterProcessesByBinary(processes, this.binaryName);
  }

  extractSessionIdFromArgs(args: string): string | undefined {
    return extractOpenCodeSessionIdFromArgs(args);
  }

  buildLaunchCommand(opts: LaunchOptions): string[] {
    const parts = ["opencode"];
    if (opts.model) parts.push("--model", opts.model);
    return parts;
  }

  buildResumeCommand(opts: ResumeOptions): string[] {
    const parts = ["opencode", "--session", opts.sessionId];
    if (opts.model) parts.push("--model", opts.model);
    return parts;
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

  /** Start SSE event subscription if server is available. */
  async startEventStream(onEvent: (result: HookEventResult) => void): Promise<void> {
    if (!isSSEActive()) {
      await startOpenCodeEventStream(onEvent);
    }
  }

  /** Send text to an OpenCode session via SDK TUI methods. Returns true if successful. */
  async sendViaTUI(text: string): Promise<boolean> {
    const client = await getOpenCodeClient();
    if (!client) return false;

    try {
      // Clear, append text, then submit
      await client.tui.clearPrompt();
      await client.tui.appendPrompt({ text });
      await client.tui.submitPrompt();
      return true;
    } catch (err) {
      log.warn(`sendViaTUI: failed to send text via OpenCode TUI: ${err instanceof Error ? err.message : String(err)}`);
      return false;
    }
  }
}
