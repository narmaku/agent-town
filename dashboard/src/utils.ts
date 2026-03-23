import type { SessionStatus } from "@agent-town/shared";

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
  color: string;
  bg: string;
  pulse: boolean;
}

export const STATUS_CONFIG: Record<SessionStatus, StatusStyle> = {
  starting: { label: "Starting", color: "#a78bfa", bg: "#2e1065", pulse: true },
  working: { label: "Working", color: "#22c55e", bg: "#052e16", pulse: true },
  awaiting_input: { label: "Awaiting Input", color: "#60a5fa", bg: "#172554", pulse: false },
  action_required: { label: "Action Required", color: "#f97316", bg: "#431407", pulse: true },
  idle: { label: "Idle", color: "#6b7280", bg: "#1f2937", pulse: false },
  done: { label: "Done", color: "#3b82f6", bg: "#172554", pulse: false },
  error: { label: "Error", color: "#ef4444", bg: "#450a0a", pulse: true },
  exited: { label: "Exited", color: "#f59e0b", bg: "#451a03", pulse: true },
};

// --- Path helpers ---

export function shortenPath(path: string): string {
  const home = path.match(/^\/home\/[^/]+/)?.[0];
  if (home) return path.replace(home, "~");
  return path;
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
  AGENTS_LAUNCH: "/api/agents/launch",
  AGENTS_RESUME: "/api/agents/resume",
  SESSIONS_RECONNECT: "/api/sessions/reconnect",
  GIT_DIFF: "/api/git-diff",
  SEARCH_MESSAGES: "/api/search-messages",
  NODES: "/api/nodes",
  NODES_TEST: "/api/nodes/test",
} as const;
