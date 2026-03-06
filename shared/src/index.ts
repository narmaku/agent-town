export type SessionStatus = "working" | "needs_attention" | "idle" | "done" | "error";

export type TerminalMultiplexer = "zellij" | "tmux";

export interface SessionInfo {
  sessionId: string;
  slug: string;
  projectPath: string;
  projectName: string;
  gitBranch: string;
  status: SessionStatus;
  lastActivity: string; // ISO timestamp
  lastMessage: string; // summary of last assistant/user message
  cwd: string;
  model?: string;
  version?: string;
  multiplexerSession?: string; // zellij/tmux session name
  multiplexer?: TerminalMultiplexer;
}

export interface MachineInfo {
  machineId: string;
  hostname: string;
  platform: string;
  lastHeartbeat: string; // ISO timestamp
  sessions: SessionInfo[];
  multiplexers: TerminalMultiplexer[];
}

export interface Heartbeat {
  machineId: string;
  hostname: string;
  platform: string;
  sessions: SessionInfo[];
  multiplexers: TerminalMultiplexer[];
  timestamp: string;
}

export interface SendInstructionRequest {
  machineId: string;
  sessionId: string;
  instruction: string;
}

export interface WebSocketMessage {
  type: "heartbeat" | "machines_update" | "terminal_data" | "terminal_resize";
  payload: unknown;
}
