import {
  type AgentType,
  formatCompactTokens,
  formatCost,
  type SessionInfo,
  type TerminalMultiplexer,
} from "@agent-town/shared";
import type React from "react";
import { useEffect, useRef, useState } from "react";
import { API, STATUS_CONFIG, timeAgo } from "../utils";
import { MessageView } from "./MessageView";
import { SendMessage } from "./SendMessage";

interface Props {
  session: SessionInfo;
  machineId: string;
  onOpenTerminal: (sessionName: string, multiplexer: TerminalMultiplexer) => void;
  onResume: (sessionId: string, projectDir: string, agentType: AgentType) => void;
  onFullscreen: (session: SessionInfo) => void;
  autoDeleteOnClose?: boolean;
}

export function SessionCard({
  session,
  machineId,
  onOpenTerminal,
  onResume,
  onFullscreen,
  autoDeleteOnClose,
}: Props): React.JSX.Element {
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
  const hasTerminal = session.multiplexer && session.multiplexerSession;

  async function handleRename() {
    setEditing(false);
    const trimmed = name.trim();
    if (trimmed === (session.customName || "")) return;

    try {
      await fetch(API.SESSIONS_RENAME, {
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
    if ((e.target as HTMLElement).closest(".session-name-primary")) return;
    if ((e.target as HTMLElement).closest(".card-actions")) return;
    setExpanded((prev) => !prev);
  }

  function startRename(e: React.MouseEvent) {
    e.stopPropagation();
    setEditing(true);
  }

  function handleOpenTerminal(e: React.MouseEvent) {
    e.stopPropagation();
    if (hasTerminal) {
      onOpenTerminal(session.multiplexerSession!, session.multiplexer!);
    }
  }

  async function handleKillSession(e: React.MouseEvent) {
    e.stopPropagation();
    if (!hasTerminal) return;
    if (!window.confirm(`Close session "${session.multiplexerSession}"? This will terminate the agent.`)) return;

    try {
      const resp = await fetch(API.SESSIONS_KILL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          machineId,
          multiplexer: session.multiplexer,
          session: session.multiplexerSession,
        }),
      });

      if (resp.ok && autoDeleteOnClose) {
        try {
          await fetch(API.SESSIONS_DELETE, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              machineId,
              sessionId: session.sessionId,
            }),
          });
        } catch {
          // deletion is best-effort
        }
      }
    } catch {
      // will disappear on next heartbeat
    }
  }

  return (
    // biome-ignore lint/a11y/useSemanticElements: card component with complex content, not a simple button
    <div
      className={`session-card ${expanded ? "expanded" : ""}`}
      style={{ borderLeftColor: config.color, background: config.bg }}
      onClick={handleCardClick}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          handleCardClick(e as unknown as React.MouseEvent);
        }
      }}
      role="button"
      tabIndex={0}
    >
      <div className="session-header">
        <div className="session-status">
          <span className={`status-dot ${config.pulse ? "pulse" : ""}`} style={{ background: config.color }} />
          <span className="status-label" style={{ color: config.color }}>
            {config.label}
          </span>
          {session.currentTool && <span className="current-tool-badge">{session.currentTool}</span>}
          {session.agentType && session.agentType !== "claude-code" && (
            <span className="agent-type-badge" title={`Agent: ${session.agentType}`}>
              {session.agentType === "opencode" ? "OC" : session.agentType}
            </span>
          )}
          {session.status !== "starting" && (
            <span
              className={`tracking-badge ${session.hookEnabled ? "hook" : "heuristic"}`}
              title={session.hookEnabled ? "Real-time tracking via hooks" : "Estimated status (no hooks)"}
            >
              {session.hookEnabled ? "LIVE" : "EST"}
            </span>
          )}
        </div>
        <span className="session-time">{timeAgo(session.lastActivity)}</span>
      </div>

      <div className="session-project">
        {/* biome-ignore lint/a11y/noStaticElementInteractions: double-click rename is secondary interaction */}
        <span
          className="session-name-primary"
          onDoubleClick={startRename}
          title={
            hasTerminal
              ? `${session.multiplexer}: ${session.multiplexerSession} — double-click to rename`
              : "Double-click to rename"
          }
        >
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
            <span className="session-name">{displayName}</span>
          )}
        </span>
        {session.gitBranch && (
          <span className="git-branch" title="Git branch">
            {session.gitBranch}
          </span>
        )}
      </div>

      {!expanded && session.status === "action_required" && (
        <div className="session-message action-hint">Agent is asking a question — open terminal to respond</div>
      )}
      {!expanded && session.status !== "action_required" && session.lastMessage && (
        <div className="session-message">{session.lastMessage}</div>
      )}

      {expanded && (
        <div className="session-details">
          {/* Rich-formatted last assistant message */}
          <MessageView lastMessage={session.lastMessage} fullMessage={session.lastAssistantMessage} />
          <div className="detail-row">
            <span className="detail-label">Session ID</span>
            <span className="detail-value mono">{session.sessionId}</span>
          </div>
          <div className="detail-row">
            <span className="detail-label">Working Dir</span>
            <span className="detail-value mono">{session.cwd}</span>
          </div>
          {session.gitBranch && (
            <div className="detail-row">
              <span className="detail-label">Branch</span>
              <span className="detail-value mono">{session.gitBranch}</span>
            </div>
          )}
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
          {session.totalInputTokens != null && session.totalInputTokens > 0 && (
            <div className="detail-row">
              <span className="detail-label">Tokens</span>
              <span className="detail-value mono">
                {session.totalInputTokens.toLocaleString()} in / {(session.totalOutputTokens ?? 0).toLocaleString()} out
              </span>
            </div>
          )}
          {session.estimatedCost != null && session.estimatedCost > 0 && (
            <div className="detail-row">
              <span className="detail-label">Est. Cost</span>
              <span className="detail-value mono">~{formatCost(session.estimatedCost)}</span>
            </div>
          )}
          <div className="card-actions">
            <button
              type="button"
              className="action-btn"
              onClick={(e) => {
                e.stopPropagation();
                onFullscreen(session);
              }}
              title="Expand to fullscreen"
            >
              Expand
            </button>
            {hasTerminal && (
              <button type="button" className="action-btn terminal-btn" onClick={handleOpenTerminal}>
                Open Terminal
              </button>
            )}
            {(session.status === "exited" || session.status === "done" || !hasTerminal) && (
              <button
                type="button"
                className="action-btn resume-btn"
                onClick={(e) => {
                  e.stopPropagation();
                  onResume(session.sessionId, session.projectPath, session.agentType);
                }}
              >
                Resume
              </button>
            )}
            {!hasTerminal && (
              <button
                type="button"
                className="action-btn kill-btn"
                onClick={async (e) => {
                  e.stopPropagation();
                  if (
                    !window.confirm(
                      `Permanently delete session "${session.customName || session.slug}"?\n\nThis removes the conversation history and cannot be undone.`,
                    )
                  )
                    return;
                  try {
                    await fetch(API.SESSIONS_DELETE, {
                      method: "POST",
                      headers: { "Content-Type": "application/json" },
                      body: JSON.stringify({
                        machineId,
                        sessionId: session.sessionId,
                        multiplexer: session.multiplexer,
                        multiplexerSession: session.multiplexerSession,
                      }),
                    });
                  } catch {
                    // will disappear on next heartbeat
                  }
                }}
              >
                Delete
              </button>
            )}
            {hasTerminal && (
              <button type="button" className="action-btn kill-btn" onClick={handleKillSession}>
                Close Agent
              </button>
            )}
          </div>

          {/* Send message to agent */}
          {hasTerminal && (
            <SendMessage
              machineId={machineId}
              multiplexer={session.multiplexer!}
              session={session.multiplexerSession!}
              agentType={session.agentType}
            />
          )}
        </div>
      )}

      {!expanded && (
        <div className="session-footer">
          <span className="session-cwd" title={session.cwd}>
            {session.cwd}
          </span>
          <span className="session-footer-right">
            {session.totalInputTokens != null && session.totalInputTokens > 0 && (
              <span
                className="session-tokens"
                title={`${session.totalInputTokens?.toLocaleString() ?? 0} in / ${session.totalOutputTokens?.toLocaleString() ?? 0} out`}
              >
                ~{formatCompactTokens((session.totalInputTokens ?? 0) + (session.totalOutputTokens ?? 0))} tokens
                {session.estimatedCost != null && session.estimatedCost > 0 && (
                  <> &middot; ~{formatCost(session.estimatedCost)}</>
                )}
              </span>
            )}
            {session.model && <span className="session-model">{session.model}</span>}
          </span>
        </div>
      )}
    </div>
  );
}
