import { useState, useRef, useEffect } from "react";
import type { SessionInfo, SessionStatus } from "@agent-town/shared";

const STATUS_CONFIG: Record<
  SessionStatus,
  { label: string; color: string; bg: string; pulse: boolean }
> = {
  working: { label: "Working", color: "#22c55e", bg: "#052e16", pulse: true },
  needs_attention: {
    label: "Needs Attention",
    color: "#eab308",
    bg: "#422006",
    pulse: true,
  },
  idle: { label: "Idle", color: "#6b7280", bg: "#1f2937", pulse: false },
  done: { label: "Done", color: "#3b82f6", bg: "#172554", pulse: false },
  error: { label: "Error", color: "#ef4444", bg: "#450a0a", pulse: true },
};

function timeAgo(timestamp: string): string {
  const seconds = Math.floor(
    (Date.now() - new Date(timestamp).getTime()) / 1000
  );
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
  onOpenTerminal: (sessionId: string, sessionLabel: string, cwd: string) => void;
}

export function SessionCard({ session, machineId, onOpenTerminal }: Props) {
  const config = STATUS_CONFIG[session.status];
  const [expanded, setExpanded] = useState(false);
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(session.customName || "");
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (editing) inputRef.current?.focus();
  }, [editing]);

  useEffect(() => {
    if (!editing) setName(session.customName || "");
  }, [session.customName, editing]);

  const displayName = session.customName || session.slug;

  async function handleRename() {
    setEditing(false);
    const trimmed = name.trim();
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
      setName(session.customName || "");
    }
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    e.stopPropagation();
    if (e.key === "Enter") handleRename();
    if (e.key === "Escape") {
      setName(session.customName || "");
      setEditing(false);
    }
  }

  function handleCardClick(e: React.MouseEvent) {
    if ((e.target as HTMLElement).closest(".session-slug")) return;
    if ((e.target as HTMLElement).closest(".card-actions")) return;
    setExpanded((prev) => !prev);
  }

  function startRename(e: React.MouseEvent) {
    e.stopPropagation();
    setEditing(true);
  }

  function handleOpenTerminal(e: React.MouseEvent) {
    e.stopPropagation();
    onOpenTerminal(session.sessionId, displayName, session.cwd);
  }

  return (
    <div
      className={`session-card ${expanded ? "expanded" : ""}`}
      style={{ borderLeftColor: config.color, background: config.bg }}
      onClick={handleCardClick}
    >
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
          <span className="git-branch" title="Git branch">
            {session.gitBranch}
          </span>
        )}
      </div>

      <div className="session-slug" onDoubleClick={startRename}>
        {editing ? (
          <input
            ref={inputRef}
            className="rename-input"
            value={name}
            onChange={(e) => setName(e.target.value)}
            onBlur={handleRename}
            onKeyDown={handleKeyDown}
            onClick={(e) => e.stopPropagation()}
            placeholder={session.slug}
          />
        ) : (
          <span className="session-name" title="Double-click to rename">
            {displayName}
          </span>
        )}
      </div>

      {session.lastMessage && (
        <div className={`session-message ${expanded ? "expanded" : ""}`}>
          {session.lastMessage}
        </div>
      )}

      {expanded && (
        <div className="session-details">
          <div className="detail-row">
            <span className="detail-label">Session ID</span>
            <span className="detail-value mono">{session.sessionId}</span>
          </div>
          <div className="detail-row">
            <span className="detail-label">Working Dir</span>
            <span className="detail-value mono">{session.cwd}</span>
          </div>
          {session.model && (
            <div className="detail-row">
              <span className="detail-label">Model</span>
              <span className="detail-value mono">{session.model}</span>
            </div>
          )}
          {session.version && (
            <div className="detail-row">
              <span className="detail-label">Claude Code</span>
              <span className="detail-value mono">v{session.version}</span>
            </div>
          )}
          <div className="card-actions">
            <button className="action-btn rename-btn" onClick={startRename}>
              Rename
            </button>
            <button
              className="action-btn terminal-btn"
              onClick={handleOpenTerminal}
            >
              Open Terminal
            </button>
          </div>
        </div>
      )}

      {!expanded && (
        <div className="session-footer">
          <span className="session-cwd" title={session.cwd}>
            {session.cwd}
          </span>
          {session.model && (
            <span className="session-model">{session.model}</span>
          )}
        </div>
      )}
    </div>
  );
}
