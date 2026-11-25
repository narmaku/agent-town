import type { SessionInfo, SessionMessagesResponse } from "@agent-town/shared";
import { applyPermissionMode } from "../permission-mode";
import type { SearchMessageResult } from "../search";
import type { AgentProcess, AgentProvider, LaunchOptions, ResumeOptions } from "../types";
import { getPiSessionMessages, searchPiMessages } from "./message-parser";
import { extractPiSessionIdFromArgs, filterPiProcesses, matchPiProcessToSession } from "./process-mapper";
import { deletePiSessionData, discoverPiSessions } from "./session-discovery";

export interface PiIdentityResult {
  exitCode: number;
  output: string;
}

export type PiIdentityRunner = () => Promise<PiIdentityResult>;

export async function isPiCliAvailable(run: PiIdentityRunner = runPiHelp): Promise<boolean> {
  try {
    const result = await run();
    return (
      result.exitCode === 0 &&
      /usage:\s*pi\b/i.test(result.output) &&
      /--model\b/i.test(result.output) &&
      /--session\b/i.test(result.output)
    );
  } catch (_err) {
    return false;
  }
}

export class PiProvider implements AgentProvider {
  readonly type = "pi" as const;
  readonly displayName = "Pi";
  readonly binaryName = "pi";
  readonly terminal = {
    inputMode: "bracketed-paste",
    startupMode: "tui",
    autonomousDisclaimer: false,
  } as const;

  async isAvailable(): Promise<boolean> {
    return isPiCliAvailable();
  }

  async discoverSessions(): Promise<SessionInfo[]> {
    return discoverPiSessions();
  }

  async getSessionMessages(sessionId: string, offset: number, limit: number): Promise<SessionMessagesResponse> {
    return getPiSessionMessages(sessionId, offset, limit);
  }

  async searchMessages(query: string, maxResults: number): Promise<SearchMessageResult[]> {
    return searchPiMessages(query, maxResults);
  }

  filterAgentProcesses(processes: AgentProcess[]): AgentProcess[] {
    return filterPiProcesses(processes);
  }

  extractSessionIdFromArgs(args: string): string | undefined {
    return extractPiSessionIdFromArgs(args);
  }

  buildLaunchCommand(options: LaunchOptions): string[] {
    const command = ["pi"];
    if (options.model) command.push("--model", options.model);
    return applyPermissionMode(this.type, command, options);
  }

  buildResumeCommand(options: ResumeOptions): string[] {
    const command = ["pi", "--session", options.sessionId];
    if (options.model) command.push("--model", options.model);
    return applyPermissionMode(this.type, command, options);
  }

  async matchProcessToSessionId(
    cwd: string,
    processStartMs: number,
    claimedIds: Set<string>,
  ): Promise<string | undefined> {
    return matchPiProcessToSession(cwd, processStartMs, claimedIds);
  }

  async deleteSessionData(sessionId: string): Promise<boolean> {
    return deletePiSessionData(sessionId);
  }
}

async function runPiHelp(): Promise<PiIdentityResult> {
  const process = Bun.spawn(["pi", "--help"], { stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, exitCode] = await Promise.all([
    Bun.readableStreamToText(process.stdout),
    Bun.readableStreamToText(process.stderr),
    process.exited,
  ]);
  return { exitCode, output: `${stdout}\n${stderr}` };
}
