import type { AgentType, SessionInfo, TerminalMultiplexer } from "@agent-town/shared";
import type React from "react";
import { useState } from "react";

import { createBrowserLogger } from "../logger";
import { API } from "../utils";
import { DiffModal } from "./DiffModal";
import { MessageView } from "./MessageView";
import { SendMessage } from "./SendMessage";

const logger = createBrowserLogger("SessionExpanded");

interface Props {
  session: SessionInfo;
  machineId: string;
  onOpenTerminal: (sessionName: string, multiplexer: TerminalMultiplexer) => void;
  onResume: (sessionId: string, projectDir: string, agentType: AgentType) => void;
  onFullscreen: (session: SessionInfo) => void;
  autoDeleteOnClose?: boolean;
}

interface DetailRow {
  label: string;
  value: string;
}

function buildDetailRows(session: SessionInfo): DetailRow[] {
  const rows: DetailRow[] = [
    { label: "Session ID", value: session.sessionId },
    { label: "Working Dir", value: session.cwd },
  ];
  if (session.gitBranch) rows.push({ label: "Branch", value: session.gitBranch });
  if (session.model) rows.push({ label: "Model", value: session.model });
  if (session.version) rows.push({ label: "Version", value: `v${session.version}` });
  if (session.totalInputTokens != null && session.totalInputTokens > 0) {
    rows.push({
      label: "Tokens",
      value: `${session.totalInputTokens.toLocaleString()} in / ${(session.totalOutputTokens ?? 0).toLocaleString()} out`,
    });
  }
  return rows;
}

/**
 * The body revealed when a session row is expanded: last message, metadata, the
 * action buttons, and the send box. Shared by every layout so an action added
 * here shows up in all of them.
 */
export function SessionExpanded({
  session,
  machineId,
  onOpenTerminal,
  onResume,
  onFullscreen,
  autoDeleteOnClose,
}: Props): React.JSX.Element {
  const [showDiff, setShowDiff] = useState(false);
  const hasTerminal = Boolean(session.multiplexer && session.multiplexerSession);
  const canResume = session.status === "exited" || session.status === "done" || !hasTerminal;
  const diffDir = session.cwd || session.projectPath;

  async function handleCloseAgent() {
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
        await deleteSession();
      }
    } catch (err) {
      // The session list is rebuilt from the next heartbeat, so a failed kill
      // corrects itself on screen within a few seconds.
      logger.warn(`Failed to close session ${session.sessionId}:`, err);
    }
  }

  async function deleteSession() {
    try {
      await fetch(API.SESSIONS_DELETE, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          machineId,
          sessionId: session.sessionId,
          agentType: session.agentType,
          multiplexer: session.multiplexer,
          multiplexerSession: session.multiplexerSession,
        }),
      });
    } catch (err) {
      logger.warn(`Failed to delete session ${session.sessionId}:`, err);
    }
  }

  async function handleDelete() {
    const name = session.customName || session.slug;
    if (
      !window.confirm(
        `Permanently delete session "${name}"?\n\nThis removes the conversation history and cannot be undone.`,
      )
    )
      return;
    await deleteSession();
  }

  return (
    <div className="session-expanded">
      <MessageView lastMessage={session.lastMessage} fullMessage={session.lastAssistantMessage} />

      <dl className="session-expanded-meta">
        {buildDetailRows(session).map((row) => (
          <div key={row.label} className="detail-row">
            <dt className="detail-label">{row.label}</dt>
            <dd className="detail-value mono">{row.value}</dd>
          </div>
        ))}
      </dl>

      <div className="card-actions">
        <button
          type="button"
          className="action-btn"
          onClick={() => onFullscreen(session)}
          aria-label={`Expand ${session.slug} to fullscreen`}
        >
          Expand
        </button>
        {hasTerminal && (
          <button
            type="button"
            className="action-btn terminal-btn"
            onClick={() => onOpenTerminal(session.multiplexerSession ?? "", session.multiplexer ?? "zellij")}
            aria-label={`Open terminal for ${session.slug}`}
          >
            Open Terminal
          </button>
        )}
        {canResume && (
          <button
            type="button"
            className="action-btn resume-btn"
            onClick={() => onResume(session.sessionId, session.projectPath, session.agentType)}
            aria-label={`Resume ${session.slug}`}
          >
            Resume
          </button>
        )}
        {diffDir && (
          <button
            type="button"
            className="action-btn diff-btn"
            onClick={() => setShowDiff(true)}
            aria-label={`View git changes for ${session.slug}`}
          >
            View Changes
          </button>
        )}
        {hasTerminal ? (
          <button
            type="button"
            className="action-btn kill-btn"
            onClick={handleCloseAgent}
            aria-label={`Close agent ${session.slug}`}
          >
            Close Agent
          </button>
        ) : (
          <button
            type="button"
            className="action-btn kill-btn"
            onClick={handleDelete}
            aria-label={`Delete ${session.slug}`}
          >
            Delete
          </button>
        )}
      </div>

      {hasTerminal && (
        <SendMessage
          machineId={machineId}
          multiplexer={session.multiplexer ?? "zellij"}
          session={session.multiplexerSession ?? ""}
          agentType={session.agentType}
        />
      )}

      {showDiff && diffDir && <DiffModal machineId={machineId} dir={diffDir} onClose={() => setShowDiff(false)} />}
    </div>
  );
}
