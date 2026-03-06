import { useState, useRef, useEffect } from "react";
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
  machineId: string;
}

export function SessionCard({ session, machineId }: Props) {
  const config = STATUS_CONFIG[session.status];
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(session.customName || "");
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (editing) inputRef.current?.focus();
  }, [editing]);

  const displayName = session.customName || session.slug;

  async function handleRename() {
    setEditing(false);
    const trimmed = name.trim();
    // Skip if unchanged
    if (trimmed === (session.customName || "")) return;

    try {
      await fetch("/api/sessions/rename", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          machineId,
          sessionId: session.sessionId,
          name: trimmed,
        }),
      });
    } catch {
      // revert on failure
      setName(session.customName || "");
    }
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === "Enter") handleRename();
    if (e.key === "Escape") {
      setName(session.customName || "");
      setEditing(false);
    }
  }

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

      <div className="session-slug" onDoubleClick={() => setEditing(true)}>
        {editing ? (
          <input
            ref={inputRef}
            className="rename-input"
            value={name}
            onChange={(e) => setName(e.target.value)}
            onBlur={handleRename}
            onKeyDown={handleKeyDown}
            placeholder={session.slug}
          />
        ) : (
          <span className="session-name" title="Double-click to rename">
            {displayName}
          </span>
        )}
      </div>

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
