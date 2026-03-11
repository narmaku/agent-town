import { useState } from "react";
import type { MachineInfo } from "@agent-town/shared";

interface Props {
  open: boolean;
  onClose: () => void;
  machines: MachineInfo[];
}

export function LaunchAgentModal({ open, onClose, machines }: Props) {
  const [sessionName, setSessionName] = useState("");
  const [projectDir, setProjectDir] = useState("");
  const [machineId, setMachineId] = useState("");
  const [launching, setLaunching] = useState(false);
  const [error, setError] = useState("");

  if (!open) return null;

  // Default to first machine if not selected
  const selectedMachine = machineId || machines[0]?.machineId || "";

  async function handleLaunch() {
    if (!sessionName.trim() || !projectDir.trim()) return;

    setLaunching(true);
    setError("");
    try {
      const resp = await fetch("/api/agents/launch", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          machineId: selectedMachine,
          sessionName: sessionName.trim(),
          projectDir: projectDir.trim(),
        }),
      });

      if (resp.ok) {
        setSessionName("");
        setProjectDir("");
        setError("");
        onClose();
      } else {
        const data = await resp.json().catch(() => ({ error: "Launch failed" }));
        setError(data.error || "Launch failed");
      }
    } catch {
      setError("Failed to connect to server");
    } finally {
      setLaunching(false);
    }
  }

  function handleOverlayClick(e: React.MouseEvent) {
    if (e.target === e.currentTarget) onClose();
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === "Enter" && sessionName.trim() && projectDir.trim()) {
      handleLaunch();
    }
    if (e.key === "Escape") {
      onClose();
    }
  }

  return (
    <div className="modal-overlay" onClick={handleOverlayClick}>
      <div className="modal-panel">
        <div className="modal-header">
          <h2 className="modal-title">New Agent</h2>
          <button className="modal-close" onClick={onClose}>
            &times;
          </button>
        </div>
        <div className="modal-body">
          {machines.length > 1 && (
            <div className="form-group">
              <label className="form-label">Machine</label>
              <select
                className="form-select"
                value={selectedMachine}
                onChange={(e) => setMachineId(e.target.value)}
              >
                {machines.map((m) => (
                  <option key={m.machineId} value={m.machineId}>
                    {m.hostname}
                  </option>
                ))}
              </select>
            </div>
          )}
          <div className="form-group">
            <label className="form-label">Session Name</label>
            <input
              className="form-input"
              type="text"
              value={sessionName}
              onChange={(e) => setSessionName(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="e.g. my-agent"
              autoFocus
            />
          </div>
          <div className="form-group">
            <label className="form-label">Project Directory</label>
            <input
              className="form-input"
              type="text"
              value={projectDir}
              onChange={(e) => setProjectDir(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="/home/user/project"
            />
          </div>
          {error && <div className="form-error">{error}</div>}
        </div>
        <div className="modal-footer">
          <button className="action-btn" onClick={onClose}>
            Cancel
          </button>
          <button
            className="send-btn"
            onClick={handleLaunch}
            disabled={launching || !sessionName.trim() || !projectDir.trim()}
          >
            {launching ? "Launching..." : "Launch"}
          </button>
        </div>
      </div>
    </div>
  );
}
