import type { AgentType, SessionStatus } from "@agent-town/shared";

// --- Time formatting ---

export function timeAgo(timestamp: string): string {
  const seconds = Math.floor((Date.now() - new Date(timestamp).getTime()) / 1000);
  if (seconds < 10) return "just now";
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ago`;
}

// --- Status display ---

export interface StatusStyle {
  label: string;
  pulse: boolean;
}

/**
 * Status colours are NOT here — they live in styles.css as `--status-<name>-fg`
 * and `--status-<name>-bg`. Put `data-status={session.status}` on any element
 * and every descendant can read `var(--status-fg)` / `var(--status-bg)`, so the
 * light theme restyles them by redefining tokens instead of fighting inline
 * styles with `!important`.
 */
export const STATUS_CONFIG: Record<SessionStatus, StatusStyle> = {
  starting: { label: "Starting", pulse: true },
  working: { label: "Working", pulse: true },
  awaiting_input: { label: "Awaiting Input", pulse: false },
  action_required: { label: "Action Required", pulse: true },
  idle: { label: "Idle", pulse: false },
  done: { label: "Done", pulse: false },
  error: { label: "Error", pulse: true },
  exited: { label: "Exited", pulse: true },
};

// --- Path helpers ---

export function shortenPath(path: string): string {
  const home = path.match(/^\/home\/[^/]+/)?.[0];
  if (home) return path.replace(home, "~");
  return path;
}

// --- Agent type labels ---

export interface AgentTypeDisplayConfig {
  label: string;
  shortLabel: string;
  autonomousHint: string;
  autonomousSupported: boolean;
}

export const AGENT_TYPE_CONFIG: Record<AgentType, AgentTypeDisplayConfig> = {
  "claude-code": {
    label: "Claude Code",
    shortLabel: "CC",
    autonomousHint: "Skips all permission checks (--dangerously-skip-permissions).",
    autonomousSupported: true,
  },
  opencode: {
    label: "OpenCode",
    shortLabel: "OC",
    autonomousHint: 'OpenCode uses config-based permissions — ensure opencode.json has permission: "allow".',
    autonomousSupported: true,
  },
  "gemini-cli": {
    label: "Gemini CLI",
    shortLabel: "GE",
    autonomousHint: "Auto-approves all actions (--yolo mode).",
    autonomousSupported: true,
  },
  codex: {
    label: "Codex CLI",
    shortLabel: "CX",
    autonomousHint: "Bypasses approvals and sandboxing (--dangerously-bypass-approvals-and-sandbox).",
    autonomousSupported: true,
  },
  pi: {
    label: "Pi",
    shortLabel: "PI",
    autonomousHint: "Pi has no permission layer; the Autonomous setting does not apply.",
    autonomousSupported: false,
  },
};

export const AGENT_TYPE_LABELS: Record<AgentType, string> = Object.fromEntries(
  (Object.entries(AGENT_TYPE_CONFIG) as [AgentType, AgentTypeDisplayConfig][]).map(([type, config]) => [
    type,
    config.label,
  ]),
) as Record<AgentType, string>;

export function resolveAvailableAgentType(preferred: AgentType, available: AgentType[]): AgentType {
  return available.includes(preferred) ? preferred : (available[0] ?? preferred);
}

export function normalizeAutonomousSetting(agentType: AgentType, requested: boolean): boolean {
  return AGENT_TYPE_CONFIG[agentType].autonomousSupported && requested;
}

// --- API endpoints ---

export const API = {
  SETTINGS: "/api/settings",
  MACHINES: "/api/machines",
  SESSION_MESSAGES: "/api/session-messages",
  SESSIONS_RENAME: "/api/sessions/rename",
  SESSIONS_KILL: "/api/sessions/kill",
  SESSIONS_DELETE: "/api/sessions/delete",
  SESSIONS_SEND: "/api/sessions/send",
  SESSIONS_UPLOAD: "/api/sessions/upload",
  AGENTS_LAUNCH: "/api/agents/launch",
  AGENTS_RESUME: "/api/agents/resume",
  SESSIONS_RECONNECT: "/api/sessions/reconnect",
  GIT_DIFF: "/api/git-diff",
  SEARCH_MESSAGES: "/api/search-messages",
  LIST_DIRS: "/api/list-dirs",
  NODES: "/api/nodes",
  NODES_TEST: "/api/nodes/test",
} as const;
