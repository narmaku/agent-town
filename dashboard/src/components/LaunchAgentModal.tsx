import type { AgentType, MachineInfo, Settings, TerminalMultiplexer } from "@agent-town/shared";
import type React from "react";
import { useEffect, useMemo, useRef, useState } from "react";
import { AGENT_TYPE_LABELS, API } from "../utils";

interface Props {
  open: boolean;
  onClose: () => void;
  machines: MachineInfo[];
  onLaunched: (machineId: string, sessionName: string, multiplexer: TerminalMultiplexer) => void;
}

export function LaunchAgentModal({ open, onClose, machines, onLaunched }: Props): React.JSX.Element | null {
  const [sessionName, setSessionName] = useState("");
  const [projectDir, setProjectDir] = useState("");
  const [machineId, setMachineId] = useState("");
  const [agentType, setAgentType] = useState<AgentType>("claude-code");
  const [multiplexer, setMultiplexer] = useState<TerminalMultiplexer>("tmux");
  const [autonomous, setAutonomous] = useState(false);
  const [launching, setLaunching] = useState(false);
  const [error, setError] = useState("");
  const [globalSettings, setGlobalSettings] = useState<Settings | null>(null);

  useEffect(() => {
    if (open) {
      fetch(API.SETTINGS)
        .then((r) => r.json())
        .then((s: Settings) => {
          setGlobalSettings(s);
          if (s.defaultAgentType) setAgentType(s.defaultAgentType);
        })
        .catch(() => {});
    }
  }, [open]);

  const selectedMachineId = machineId || machines[0]?.machineId || "";
  const selectedMachine = machines.find((m) => m.machineId === selectedMachineId);

  // Available multiplexers for the selected machine (from heartbeat data)
  const availableMux = useMemo(() => {
    return selectedMachine?.multiplexers || [];
  }, [selectedMachine]);

  // Track which machine+settings combo we last initialized for, so we don't
  // reset user choices on every WebSocket heartbeat update.
  const initializedForRef = useRef("");

  // When machine changes or settings load, initialize multiplexer and project dir.
  // Skips re-initialization if we've already set defaults for this machine+settings combo.
  useEffect(() => {
    if (!selectedMachine) return;

    const initKey = `${selectedMachineId}:${globalSettings?.defaultMultiplexer || ""}`;
    if (initializedForRef.current === initKey) return;
    initializedForRef.current = initKey;

    // Pick the best multiplexer: prefer global default if available, otherwise first available
    const globalDefault = globalSettings?.defaultMultiplexer;
    if (globalDefault && availableMux.includes(globalDefault)) {
      setMultiplexer(globalDefault);
    } else if (availableMux.length > 0) {
      setMultiplexer(availableMux[0]);
    }

    // Set default project dir based on machine
    const isFirstMachine = machines.indexOf(selectedMachine) === 0;
    if (isFirstMachine && globalSettings?.defaultProjectDir) {
      setProjectDir(globalSettings.defaultProjectDir);
    } else {
      // For remote machines, guess home dir from session paths
      const firstSessionPath = selectedMachine.sessions[0]?.projectPath;
      const homeMatch = firstSessionPath?.match(/^(\/home\/[^/]+)/);
      setProjectDir(homeMatch ? homeMatch[1] : "/home");
    }
  }, [availableMux, globalSettings, selectedMachine, selectedMachineId, machines]);

  // Reset initialization tracking when modal opens so defaults are re-applied
  useEffect(() => {
    if (open) {
      initializedForRef.current = "";
    }
  }, [open]);

  if (!open) return null;

  async function handleLaunch() {
    if (!sessionName.trim() || !projectDir.trim()) return;

    setLaunching(true);
    setError("");
    try {
      const resp = await fetch(API.AGENTS_LAUNCH, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          machineId: selectedMachineId,
          sessionName: sessionName.trim(),
          projectDir: projectDir.trim(),
          agentType,
          autonomous,
          multiplexer,
        }),
      });

      if (resp.ok) {
        const data = await resp.json();
        const launchedName = sessionName.trim();
        setSessionName("");
        setProjectDir("");
        setError("");
        onClose();
        onLaunched(selectedMachineId, data.sessionName || launchedName, data.multiplexer || multiplexer);
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

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === "Enter" && sessionName.trim() && projectDir.trim()) handleLaunch();
    if (e.key === "Escape") onClose();
  }

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: modal backdrop
    <div
      className="modal-overlay"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
      onKeyDown={(e) => {
        if (e.key === "Escape") onClose();
      }}
      role="presentation"
    >
      <div className="modal-panel">
        <div className="modal-header">
          <h2 className="modal-title">New Agent</h2>
          <button type="button" className="modal-close" onClick={onClose} aria-label="Close">
            &times;
          </button>
        </div>
        <div className="modal-body">
          {machines.length > 1 && (
            <div className="form-group">
              <label className="form-label" htmlFor="launch-machine">
                Machine
              </label>
              <select
                id="launch-machine"
                className="form-select"
                value={selectedMachineId}
                onChange={(e) => {
                  setMachineId(e.target.value);
                  setProjectDir("");
                }}
              >
                {machines.map((m) => (
                  <option key={m.machineId} value={m.machineId}>
                    {m.hostname}
                  </option>
                ))}
              </select>
            </div>
          )}

          {availableMux.length > 1 && (
            <div className="form-group">
              <label className="form-label" htmlFor="launch-multiplexer">
                Terminal Multiplexer
              </label>
              <select
                id="launch-multiplexer"
                className="form-select"
                value={multiplexer}
                onChange={(e) => setMultiplexer(e.target.value as TerminalMultiplexer)}
              >
                {availableMux.map((m) => (
                  <option key={m} value={m}>
                    {m === "zellij" ? "Zellij" : "tmux"}
                  </option>
                ))}
              </select>
            </div>
          )}

          {availableMux.length === 1 && (
            <div className="form-group">
              <span className="form-label">Terminal Multiplexer</span>
              <div className="form-static">{availableMux[0] === "zellij" ? "Zellij" : "tmux"}</div>
            </div>
          )}

          {availableMux.length === 0 && (
            <div className="form-error">No terminal multiplexer (zellij/tmux) found on this machine.</div>
          )}

          <div className="form-group">
            <label className="form-label" htmlFor="launch-agent-type">
              Agent Type
            </label>
            <select
              id="launch-agent-type"
              className="form-select"
              value={agentType}
              onChange={(e) => setAgentType(e.target.value as AgentType)}
            >
              {(Object.keys(AGENT_TYPE_LABELS) as AgentType[]).map((t) => (
                <option key={t} value={t}>
                  {AGENT_TYPE_LABELS[t]}
                </option>
              ))}
            </select>
          </div>

          <div className="form-group">
            <label className="form-label" htmlFor="launch-session-name">
              Session Name
            </label>
            <input
              id="launch-session-name"
              className="form-input"
              type="text"
              value={sessionName}
              onChange={(e) => setSessionName(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="e.g. my-agent"
            />
          </div>
          <div className="form-group">
            <label className="form-label" htmlFor="launch-project-dir">
              Project Directory
            </label>
            <input
              id="launch-project-dir"
              className="form-input"
              type="text"
              value={projectDir}
              onChange={(e) => setProjectDir(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="/home/user/project"
            />
          </div>
          <div className="form-group">
            <label className="form-toggle-row">
              <input type="checkbox" checked={autonomous} onChange={(e) => setAutonomous(e.target.checked)} />
              <span className="form-toggle-label">Autonomous</span>
            </label>
            {autonomous && (
              <span className="form-hint" style={{ color: "var(--yellow)" }}>
                {agentType === "claude-code"
                  ? "Skips all permission checks (--dangerously-skip-permissions)."
                  : agentType === "gemini-cli"
                    ? "Auto-approves all actions (--yolo mode)."
                    : 'OpenCode uses config-based permissions — ensure opencode.json has permission: "allow".'}
              </span>
            )}
          </div>
          {error && <div className="form-error">{error}</div>}
        </div>
        <div className="modal-footer">
          <button type="button" className="action-btn" onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className="send-btn"
            onClick={handleLaunch}
            disabled={launching || !sessionName.trim() || !projectDir.trim() || availableMux.length === 0}
          >
            {launching ? "Launching..." : "Launch"}
          </button>
        </div>
      </div>
    </div>
  );
}
