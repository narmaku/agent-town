export type SessionStatus = "working" | "needs_attention" | "idle" | "done" | "error";

export type TerminalMultiplexer = "zellij" | "tmux";

export interface SessionInfo {
  sessionId: string;
  slug: string;
  customName?: string; // user-defined rename from the dashboard
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

export interface MultiplexerSessionInfo {
  name: string;
  multiplexer: TerminalMultiplexer;
  attached: boolean;
}

export interface MachineInfo {
  machineId: string;
  hostname: string;
  platform: string;
  lastHeartbeat: string; // ISO timestamp
  sessions: SessionInfo[];
  multiplexers: TerminalMultiplexer[];
  multiplexerSessions: MultiplexerSessionInfo[];
  terminalPort?: number; // port for terminal WebSocket on the agent
  agentAddress?: string; // agent's reachable address (IP or hostname)
}

export interface Heartbeat {
  machineId: string;
  hostname: string;
  platform: string;
  sessions: SessionInfo[];
  multiplexers: TerminalMultiplexer[];
  multiplexerSessions: MultiplexerSessionInfo[];
  terminalPort: number;
  timestamp: string;
}

export interface SendInstructionRequest {
  machineId: string;
  sessionId: string;
  instruction: string;
}

export interface RenameSessionRequest {
  machineId: string;
  sessionId: string;
  name: string;
}

export interface WebSocketMessage {
  type: "heartbeat" | "machines_update" | "terminal_data" | "terminal_resize";
  payload: unknown;
}
