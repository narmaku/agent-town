import { formatCompactTokens, type SessionInfo } from "@agent-town/shared";
import { AGENT_TYPE_LABELS, STATUS_CONFIG } from "../utils";

interface InfoPaneProps {
  session: SessionInfo;
  displayMachineName: string;
  showThinking: boolean;
  onToggleThinking: () => void;
  showToolDetails: boolean;
  onToggleToolDetails: () => void;
  actionButtons: React.ReactNode;
}

export function InfoPane({
  session,
  displayMachineName,
  showThinking,
  onToggleThinking,
  showToolDetails,
  onToggleToolDetails,
  actionButtons,
}: InfoPaneProps): React.JSX.Element {
  const config = STATUS_CONFIG[session.status];
  const agentLabel = AGENT_TYPE_LABELS[session.agentType] || session.agentType;

  return (
    <div className="info-pane-content">
      <div className="info-pane-agent-header">
        <span className={`info-pane-agent-badge agent-${session.agentType}`}>{agentLabel}</span>
        <span className="info-pane-machine-name" title={displayMachineName}>
          @ {displayMachineName}
        </span>
      </div>

      <div className="info-pane-status-row">
        <span className={`status-dot ${config.pulse ? "pulse" : ""}`} style={{ background: config.color }} />
        <span style={{ color: config.color }}>{config.label}</span>
        <span
          className={`tracking-badge ${session.hookEnabled ? "hook" : "heuristic"}`}
          title={session.hookEnabled ? "Real-time tracking via hooks" : "Estimated status (no hooks)"}
        >
          {session.hookEnabled ? "LIVE" : "EST"}
        </span>
        {session.currentTool && <span className="current-tool-badge">{session.currentTool}</span>}
      </div>

      <div className="info-pane-section">
        <div className="info-pane-detail-row" title={session.projectPath}>
          <span className="info-pane-detail-icon" aria-hidden="true">
            <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor" role="img" aria-label="Project">
              <path d="M1.5 1h5l1 1H14.5a1 1 0 011 1v10a1 1 0 01-1 1h-13a1 1 0 01-1-1V2a1 1 0 011-1z" />
            </svg>
          </span>
          <span className="detail-value mono">{session.projectPath}</span>
        </div>
        {session.gitBranch && (
          <div className="info-pane-detail-row">
            <span className="info-pane-detail-icon" aria-hidden="true">
              <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor" role="img" aria-label="Branch">
                <path d="M11.75 2.5a.75.75 0 100 1.5.75.75 0 000-1.5zm-2.25.75a2.25 2.25 0 113 2.122V6.5a2.5 2.5 0 01-2.5 2.5H7.5a1 1 0 00-1 1v1.128a2.251 2.251 0 11-1.5 0V4.872a2.25 2.25 0 111.5 0V6.5a2.5 2.5 0 002.5-2.5v-1.128A2.251 2.251 0 019.5 3.25zM4.25 12a.75.75 0 100 1.5.75.75 0 000-1.5zM4.25 2.5a.75.75 0 100 1.5.75.75 0 000-1.5z" />
              </svg>
            </span>
            <span className="detail-value mono">{session.gitBranch}</span>
          </div>
        )}
        {session.model && (
          <div className="info-pane-detail-row">
            <span className="info-pane-detail-icon" aria-hidden="true">
              <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor" role="img" aria-label="Model">
                <path d="M8 1a2 2 0 012 2v.5h2A1.5 1.5 0 0113.5 5v2H14a2 2 0 110 4h-.5v2a1.5 1.5 0 01-1.5 1.5h-2V14a2 2 0 11-4 0v-.5H4A1.5 1.5 0 012.5 12v-2H2a2 2 0 110-4h.5V4A1.5 1.5 0 014 2.5h2V2a2 2 0 012-2z" />
              </svg>
            </span>
            <span className="detail-value mono">{session.model}</span>
          </div>
        )}
        {session.totalInputTokens != null && session.totalInputTokens > 0 && (
          <div className="info-pane-detail-row">
            <span className="info-pane-detail-icon" aria-hidden="true">
              <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor" role="img" aria-label="Tokens">
                <path d="M8 2a6 6 0 100 12A6 6 0 008 2zM0 8a8 8 0 1116 0A8 8 0 010 8zm9-3a1 1 0 10-2 0v3a1 1 0 00.4.8l2 1.5a1 1 0 101.2-1.6L9 7.5V5z" />
              </svg>
            </span>
            <span className="detail-value mono">
              {session.totalInputTokens.toLocaleString()} in / {(session.totalOutputTokens ?? 0).toLocaleString()} out (
              {formatCompactTokens((session.totalInputTokens ?? 0) + (session.totalOutputTokens ?? 0))} total)
            </span>
          </div>
        )}
        {session.contextTokens != null && session.contextTokens > 0 && (
          <div className="info-pane-detail-row">
            <span className="info-pane-detail-icon" aria-hidden="true">
              <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor" role="img" aria-label="Context">
                <path d="M2 2.5A2.5 2.5 0 014.5 0h8.75a.75.75 0 01.75.75v12.5a.75.75 0 01-.75.75h-2.5a.75.75 0 010-1.5h1.75v-2h-8a1 1 0 00-.714 1.7.75.75 0 01-1.072 1.05A2.495 2.495 0 012 11.5v-9zm10.5-1h-6a1 1 0 00-1 1v6.708A2.486 2.486 0 016.5 9h6V1.5z" />
              </svg>
            </span>
            <span className="detail-value mono">{formatCompactTokens(session.contextTokens)} context</span>
          </div>
        )}
      </div>

      <div className="info-pane-section">
        <div className="info-pane-section-title">Display</div>
        <div className="info-pane-toggles">
          <label className="detail-switch" aria-label="Show thinking blocks">
            <input type="checkbox" checked={showThinking} onChange={onToggleThinking} />
            <span className="switch-slider" />
            <span className="switch-label">Thinking</span>
          </label>
          <label className="detail-switch" aria-label="Show tool details">
            <input type="checkbox" checked={showToolDetails} onChange={onToggleToolDetails} />
            <span className="switch-slider" />
            <span className="switch-label">Tools</span>
          </label>
        </div>
      </div>

      <div className="info-pane-section info-pane-section-actions">
        <div className="info-pane-actions">{actionButtons}</div>
      </div>
    </div>
  );
}
