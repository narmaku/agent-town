import { formatCompactTokens, type SessionInfo } from "@agent-town/shared";
import { AGENT_TYPE_LABELS, STATUS_CONFIG } from "../utils";
import { BranchIcon, ContextIcon, CwdIcon, FolderIcon, ModelIcon, TokensIcon } from "./icons";

export function shouldShowCwd(cwd: string, projectPath: string): boolean {
  return !!cwd && cwd !== projectPath;
}

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
            <FolderIcon />
          </span>
          <span className="detail-value mono">{session.projectPath}</span>
        </div>
        {shouldShowCwd(session.cwd, session.projectPath) && (
          <div className="info-pane-detail-row" title="Current working directory">
            <span className="info-pane-detail-icon" aria-hidden="true">
              <CwdIcon />
            </span>
            <span className="detail-value mono">{session.cwd}</span>
          </div>
        )}
        {session.gitBranch && (
          <div className="info-pane-detail-row">
            <span className="info-pane-detail-icon" aria-hidden="true">
              <BranchIcon />
            </span>
            <span className="detail-value mono">{session.gitBranch}</span>
          </div>
        )}
        {session.model && (
          <div className="info-pane-detail-row">
            <span className="info-pane-detail-icon" aria-hidden="true">
              <ModelIcon />
            </span>
            <span className="detail-value mono">{session.model}</span>
          </div>
        )}
        {session.totalInputTokens != null && session.totalInputTokens > 0 && (
          <div className="info-pane-detail-row">
            <span className="info-pane-detail-icon" aria-hidden="true">
              <TokensIcon />
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
              <ContextIcon />
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
