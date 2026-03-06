import type { SessionInfo, SessionStatus } from "@agent-town/shared";

const STATUS_CONFIG: Record<
  SessionStatus,
  { label: string; color: string; bg: string; pulse: boolean }
> = {
  working: { label: "Working", color: "#22c55e", bg: "#052e16", pulse: true },
  needs_attention: { label: "Needs Attention", color: "#eab308", bg: "#422006", pulse: true },
  idle: { label: "Idle", color: "#6b7280", bg: "#1f2937", pulse: false },
  done: { label: "Done", color: "#3b82f6", bg: "#172554", pulse: false },
  error: { label: "Error", color: "#ef4444", bg: "#450a0a", pulse: true },
};

function timeAgo(timestamp: string): string {
  const seconds = Math.floor((Date.now() - new Date(timestamp).getTime()) / 1000);
  if (seconds < 10) return "just now";
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ago`;
}

interface Props {
  session: SessionInfo;
}

export function SessionCard({ session }: Props) {
  const config = STATUS_CONFIG[session.status];

  return (
    <div className="session-card" style={{ borderLeftColor: config.color, background: config.bg }}>
      <div className="session-header">
        <div className="session-status">
          <span
            className={`status-dot ${config.pulse ? "pulse" : ""}`}
            style={{ background: config.color }}
          />
          <span className="status-label" style={{ color: config.color }}>
            {config.label}
          </span>
        </div>
        <span className="session-time">{timeAgo(session.lastActivity)}</span>
      </div>

      <div className="session-project">
        <span className="project-name">{session.projectName}</span>
        {session.gitBranch && (
          <span className="git-branch">{session.gitBranch}</span>
        )}
      </div>

      <div className="session-slug">{session.slug}</div>

      {session.lastMessage && (
        <div className="session-message">{session.lastMessage}</div>
      )}

      <div className="session-footer">
        <span className="session-cwd" title={session.cwd}>
          {session.cwd}
        </span>
        {session.model && <span className="session-model">{session.model}</span>}
      </div>
    </div>
  );
}
