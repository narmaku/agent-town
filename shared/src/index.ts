export { createLogger, type Logger } from "./logger";
export { buildShellCommand, SAFE_SHELL_RE, shellEscape } from "./shell";

export type AgentType = "claude-code" | "opencode";

export type SessionStatus =
  | "starting"
  | "working"
  | "awaiting_input"
  | "action_required"
  | "idle"
  | "done"
  | "error"
  | "exited";

export type TerminalMultiplexer = "zellij" | "tmux";

export interface SessionInfo {
  sessionId: string;
  agentType: AgentType;
  slug: string;
  customName?: string; // user-defined rename from the dashboard
  projectPath: string;
  projectName: string;
  gitBranch: string;
  status: SessionStatus;
  lastActivity: string; // ISO timestamp
  lastMessage: string; // short summary of last message
  lastAssistantMessage?: string; // full markdown text of last assistant response
  cwd: string;
  model?: string;
  version?: string;
  multiplexerSession?: string; // zellij/tmux session name
  multiplexer?: TerminalMultiplexer;
  hookEnabled?: boolean; // true if session is sending hook events (accurate status)
  currentTool?: string; // tool currently being executed (from hooks)
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

export interface Settings {
  defaultMultiplexer: TerminalMultiplexer;
  defaultAgentType: AgentType;
  zellijLayout: string;
  defaultModel?: string;
  autoDeleteOnClose: boolean;
  defaultProjectDir: string;
  fontSize: "small" | "medium" | "large";
  theme: "dark" | "light";
}

export interface LaunchAgentRequest {
  machineId: string;
  sessionName: string;
  projectDir: string;
  agentType?: AgentType;
  autonomous?: boolean;
  multiplexer?: TerminalMultiplexer;
}

export interface ResumeAgentRequest {
  machineId: string;
  sessionId: string;
  projectDir: string;
  agentType?: AgentType;
  autonomous?: boolean;
}

export interface SessionMessage {
  role: "user" | "assistant";
  timestamp: string;
  content: string;
  toolUse?: { name: string; id: string }[];
  toolResult?: string;
  model?: string;
}

export interface SessionMessagesResponse {
  messages: SessionMessage[];
  total: number;
  hasMore: boolean;
}

export interface WebSocketMessage {
  type: "heartbeat" | "machines_update" | "terminal_data" | "terminal_resize";
  payload: unknown;
}

// --- Remote nodes (multi-host SSH) ---

export type NodeStatus = "disconnected" | "connecting" | "deploying" | "connected" | "error";

export interface RemoteNode {
  id: string;
  name: string; // display name
  host: string; // SSH hostname or IP
  port: number; // SSH port (default 22)
  user: string; // SSH username
  sshKeyPath: string; // path to SSH private key on the server
  agentPort: number; // agent terminal server port on the remote (default 4681)
  status: NodeStatus;
  error?: string; // last error message
  lastConnected?: string; // ISO timestamp
  autoConnect: boolean; // connect on server start
  enableHooks: boolean; // configure Claude Code hooks on the remote
}

export interface CreateNodeRequest {
  name: string;
  host: string;
  port?: number;
  user: string;
  sshKeyPath: string;
  agentPort?: number;
  autoConnect?: boolean;
  enableHooks?: boolean;
}

export interface UpdateNodeRequest {
  name?: string;
  host?: string;
  port?: number;
  user?: string;
  sshKeyPath?: string;
  agentPort?: number;
  autoConnect?: boolean;
  enableHooks?: boolean;
}
