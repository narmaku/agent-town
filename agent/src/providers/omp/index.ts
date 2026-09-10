import type { SessionInfo, SessionMessagesResponse } from "@agent-town/shared";

import type { AgentProcess, AgentProvider, HookEventResult, LaunchOptions, ResumeOptions } from "../types";
import { getOmpSessionMessages } from "./message-parser";
import { extractOmpSessionIdFromArgs, filterOmpProcesses, matchOmpProcessToSession } from "./process-mapper";
import { deleteOmpSessionData, discoverOmpSessions } from "./session-discovery";

export interface OmpIdentityResult {
  exitCode: number;
  output: string;
}

export type OmpIdentityRunner = () => Promise<OmpIdentityResult>;

export async function isOmpCliAvailable(run: OmpIdentityRunner = runOmpVersion): Promise<boolean> {
  try {
    const result = await run();
    return result.exitCode === 0 && /^omp\s+v?\d+(?:\.\d+)+/im.test(result.output);
  } catch (_err) {
    return false;
  }
}

export class OmpProvider implements AgentProvider {
  readonly type = "omp" as const;
  readonly displayName = "OMP";
  readonly binaryName = "omp";
  readonly terminal = {
    inputMode: "bracketed-paste",
    startupMode: "tui",
    autonomousDisclaimer: false,
  } as const;

  async isAvailable(): Promise<boolean> {
    return isOmpCliAvailable();
  }

  async discoverSessions(): Promise<SessionInfo[]> {
    return discoverOmpSessions();
  }

  async getSessionMessages(sessionId: string, offset: number, limit: number): Promise<SessionMessagesResponse> {
    return getOmpSessionMessages(sessionId, offset, limit);
  }

  filterAgentProcesses(processes: AgentProcess[]): AgentProcess[] {
    return filterOmpProcesses(processes);
  }

  extractSessionIdFromArgs(args: string): string | undefined {
    return extractOmpSessionIdFromArgs(args);
  }

  buildLaunchCommand(options: LaunchOptions): string[] {
    const command = ["omp"];
    if (options.model) command.push("--model", options.model);
    if (options.autonomous) command.push("--yolo");
    return command;
  }

  buildResumeCommand(options: ResumeOptions): string[] {
    const command = ["omp", "--resume", options.sessionId];
    if (options.model) command.push("--model", options.model);
    if (options.autonomous) command.push("--yolo");
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
    return matchOmpProcessToSession(cwd, processStartMs, claimedIds);
  }

  async deleteSessionData(sessionId: string): Promise<boolean> {
    return deleteOmpSessionData(sessionId);
  }
}

async function runOmpVersion(): Promise<OmpIdentityResult> {
  const process = Bun.spawn(["omp", "--version"], { stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, exitCode] = await Promise.all([
    Bun.readableStreamToText(process.stdout),
    Bun.readableStreamToText(process.stderr),
    process.exited,
  ]);
  return { exitCode, output: `${stdout}\n${stderr}` };
}
