import type {
  AgentType,
  SessionInfo,
  SessionMessagesResponse,
  SessionStatus,
  TerminalMultiplexer,
} from "@agent-town/shared";

export interface AgentProcess {
  pid: number;
  ppid: number;
  etimes: number; // elapsed time in seconds
  args: string;
}

export interface ProcessMapping {
  multiplexer: TerminalMultiplexer;
  session: string; // multiplexer session name
  sessionId?: string; // agent session ID
  hasActiveChildren: boolean;
}

export interface LaunchOptions {
  model?: string;
  autonomous?: boolean;
}

export interface ResumeOptions {
  sessionId: string;
  model?: string;
  autonomous?: boolean;
}

export interface HookEventResult {
  sessionId: string;
  status: SessionStatus;
  currentTool?: string;
}

/**
 * Agent provider interface.
 *
 * Each supported AI coding agent (Claude Code, OpenCode, etc.) implements
 * this interface to plug into the Agent Town monitoring and control system.
 */
export interface AgentProvider {
  readonly type: AgentType;
  readonly displayName: string;
  readonly binaryName: string;

  /** Check if this agent's binary is installed on the machine. */
  isAvailable(): Promise<boolean>;

  /** Discover sessions from the agent's native storage (JSONL, SQLite, etc.). */
  discoverSessions(): Promise<SessionInfo[]>;

  /** Get paginated messages for a session. */
  getSessionMessages(sessionId: string, offset: number, limit: number): Promise<SessionMessagesResponse>;

  /** Find running agent processes from ps output. */
  filterAgentProcesses(processes: AgentProcess[]): AgentProcess[];

  /** Extract session ID from process command-line arguments. */
  extractSessionIdFromArgs(args: string): string | undefined;

  /** Build the CLI command parts to launch a new session. Returns an array of arguments. */
  buildLaunchCommand(opts: LaunchOptions): string[];

  /** Build the CLI command parts to resume an existing session. Returns an array of arguments. */
  buildResumeCommand(opts: ResumeOptions): string[];

  /** Parse an incoming hook/event payload and return normalized status. */
  handleHookEvent(payload: unknown): HookEventResult | null;

  /**
   * Match a running process to a session ID using provider-specific storage.
   * Called when extractSessionIdFromArgs returns nothing (e.g. fresh launch).
   * Returns the session ID if a match is found.
   */
  matchProcessToSessionId(cwd: string, processStartMs: number, claimedIds: Set<string>): Promise<string | undefined>;

  /** Delete session data (JSONL file, DB record, etc.). */
  deleteSessionData(sessionId: string): Promise<boolean>;
}
