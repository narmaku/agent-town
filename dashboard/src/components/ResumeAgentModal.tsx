import type { AgentType } from "@agent-town/shared";
import type React from "react";
import { useState } from "react";
import { API } from "../utils";

interface Props {
  open: boolean;
  onClose: () => void;
  sessionId: string;
  projectDir: string;
  machineId: string;
  agentType: AgentType;
}

export function ResumeAgentModal({
  open,
  onClose,
  sessionId,
  projectDir,
  machineId,
  agentType,
}: Props): React.JSX.Element | null {
  const [autonomous, setAutonomous] = useState(false);
  const [resuming, setResuming] = useState(false);
  const [error, setError] = useState("");

  if (!open) return null;

  async function handleResume() {
    setResuming(true);
    setError("");
    try {
      const resp = await fetch(API.AGENTS_RESUME, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          machineId,
          sessionId,
          projectDir,
          autonomous,
          agentType,
        }),
      });

      if (resp.ok) {
        setAutonomous(false);
        setError("");
        onClose();
      } else {
        const data = await resp.json().catch(() => ({ error: "Resume failed" }));
        setError(data.error || "Resume failed");
      }
    } catch {
      setError("Failed to connect to server");
    } finally {
      setResuming(false);
    }
  }

  function handleOverlayClick(e: React.MouseEvent) {
    if (e.target === e.currentTarget) onClose();
  }

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: modal backdrop dismissal
    <div
      className="modal-overlay"
      onClick={handleOverlayClick}
      onKeyDown={(e) => {
        if (e.key === "Escape") onClose();
      }}
      role="presentation"
    >
      <div className="modal-panel">
        <div className="modal-header">
          <h2 className="modal-title">Resume Session</h2>
          <button type="button" className="modal-close" onClick={onClose}>
            &times;
          </button>
        </div>
        <div className="modal-body">
          <div className="form-group">
            <label className="form-label" htmlFor="resume-session">
              Session
            </label>
            <input id="resume-session" className="form-input" type="text" value={sessionId.slice(0, 8)} disabled />
          </div>
          <div className="form-group">
            <label className="form-label" htmlFor="resume-project-dir">
              Project Directory
            </label>
            <input id="resume-project-dir" className="form-input" type="text" value={projectDir} disabled />
          </div>
          <div className="form-group">
            <label className="form-toggle-row">
              <input type="checkbox" checked={autonomous} onChange={(e) => setAutonomous(e.target.checked)} />
              <span className="form-toggle-label">Autonomous</span>
            </label>
            {autonomous && (
              <span className="form-hint" style={{ color: "var(--yellow)" }}>
                Skips all permission checks (--dangerously-skip-permissions). The agent will run without human approval
                for tool use.
              </span>
            )}
          </div>
          {error && <div className="form-error">{error}</div>}
        </div>
        <div className="modal-footer">
          <button type="button" className="action-btn" onClick={onClose}>
            Cancel
          </button>
          <button type="button" className="send-btn" onClick={handleResume} disabled={resuming}>
            {resuming ? "Resuming..." : "Resume"}
          </button>
        </div>
      </div>
    </div>
  );
}
