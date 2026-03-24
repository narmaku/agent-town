import type { AgentType, MachineInfo, Settings, TerminalMultiplexer } from "@agent-town/shared";
import type React from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AGENT_TYPE_LABELS, API } from "../utils";
import { DirectoryBrowserModal } from "./DirectoryBrowserModal";

export function resolveSelectedMachineId(
  userSelected: string,
  initialMachineId: string | undefined,
  firstMachineId: string,
): string {
  return userSelected || initialMachineId || firstMachineId || "";
}

interface Props {
  open: boolean;
  onClose: () => void;
  machines: MachineInfo[];
  onLaunched: (machineId: string, sessionName: string, multiplexer: TerminalMultiplexer) => void;
  initialMachineId?: string;
}

/**
 * Derive unique project directories from a machine's sessions,
 * sorted by most recent activity (newest first).
 */
export function deriveRecentDirectories(machine: MachineInfo | undefined): string[] {
  if (!machine?.sessions?.length) return [];

  // Map directory to its most recent activity timestamp
  const dirTimestamps = new Map<string, string>();
  for (const session of machine.sessions) {
    if (!session.projectPath) continue;
    const existing = dirTimestamps.get(session.projectPath);
    if (!existing || session.lastActivity > existing) {
      dirTimestamps.set(session.projectPath, session.lastActivity);
    }
  }

  // Sort by most recent activity
  return Array.from(dirTimestamps.entries())
    .sort((a, b) => b[1].localeCompare(a[1]))
    .map(([dir]) => dir);
}

export function LaunchAgentModal({
  open,
  onClose,
  machines,
  onLaunched,
  initialMachineId,
}: Props): React.JSX.Element | null {
  const [sessionName, setSessionName] = useState("");
  const [projectDir, setProjectDir] = useState("");
  const [machineId, setMachineId] = useState("");
  const [agentType, setAgentType] = useState<AgentType>("claude-code");
  const [multiplexer, setMultiplexer] = useState<TerminalMultiplexer>("tmux");
  const [autonomous, setAutonomous] = useState(false);
  const [launching, setLaunching] = useState(false);
  const [error, setError] = useState("");
  const [globalSettings, setGlobalSettings] = useState<Settings | null>(null);
  const [showRecentDirs, setShowRecentDirs] = useState(false);
  const [showBrowser, setShowBrowser] = useState(false);

  const recentDirsRef = useRef<HTMLDivElement>(null);
  const projectDirInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (open) {
      fetch(API.SETTINGS)
        .then((r) => r.json())
        .then((s: Settings) => {
          setGlobalSettings(s);
          if (s.defaultAgentType) setAgentType(s.defaultAgentType);
        })
        .catch((_err) => {
          // settings load is best-effort
        });
    }
  }, [open]);

  const selectedMachineId = resolveSelectedMachineId(machineId, initialMachineId, machines[0]?.machineId || "");
  const selectedMachine = machines.find((m) => m.machineId === selectedMachineId);

  // Available multiplexers for the selected machine (from heartbeat data)
  const availableMux = useMemo(() => {
    return selectedMachine?.multiplexers || [];
  }, [selectedMachine]);

  // Recent directories derived from session data
  const recentDirs = useMemo(() => deriveRecentDirectories(selectedMachine), [selectedMachine]);

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
      setShowRecentDirs(false);
      setShowBrowser(false);
      setMachineId("");
    }
  }, [open]);

  // Dismiss recent dirs dropdown when clicking outside
  useEffect(() => {
    if (!showRecentDirs) return;

    function handleClickOutside(e: MouseEvent) {
      if (
        recentDirsRef.current &&
        !recentDirsRef.current.contains(e.target as Node) &&
        projectDirInputRef.current &&
        !projectDirInputRef.current.contains(e.target as Node)
      ) {
        setShowRecentDirs(false);
      }
    }

    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [showRecentDirs]);

  const handleSelectRecentDir = useCallback((dir: string) => {
    setProjectDir(dir);
    setShowRecentDirs(false);
  }, []);

  const handleBrowseSelect = useCallback((path: string) => {
    setProjectDir(path);
  }, []);

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
    } catch (_err) {
      setError("Failed to connect to server");
    } finally {
      setLaunching(false);
    }
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === "Enter" && sessionName.trim() && projectDir.trim()) handleLaunch();
    if (e.key === "Escape") onClose();
  }

  function handleProjectDirFocus() {
    if (recentDirs.length > 0) {
      setShowRecentDirs(true);
    }
  }

  function handleProjectDirChange(e: React.ChangeEvent<HTMLInputElement>) {
    setProjectDir(e.target.value);
    setShowRecentDirs(false);
  }

  return (
    <>
      {/* biome-ignore lint/a11y/noStaticElementInteractions: modal backdrop */}
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
            <div className="form-group form-group-dir">
              <label className="form-label" htmlFor="launch-project-dir">
                Project Directory
              </label>
              <div className="form-input-with-button">
                <input
                  ref={projectDirInputRef}
                  id="launch-project-dir"
                  className="form-input"
                  type="text"
                  value={projectDir}
                  onChange={handleProjectDirChange}
                  onFocus={handleProjectDirFocus}
                  onKeyDown={handleKeyDown}
                  placeholder="/home/user/project"
                  autoComplete="off"
                />
                <button
                  type="button"
                  className="action-btn browse-btn"
                  onClick={() => setShowBrowser(true)}
                  aria-label="Browse directories"
                >
                  Browse...
                </button>
              </div>
              {showRecentDirs && recentDirs.length > 0 && (
                <div
                  className="recent-dirs-dropdown"
                  ref={recentDirsRef}
                  role="listbox"
                  aria-label="Recent directories"
                >
                  {recentDirs.map((dir) => (
                    <button
                      type="button"
                      className="recent-dirs-item"
                      key={dir}
                      onClick={() => handleSelectRecentDir(dir)}
                      role="option"
                      aria-selected={dir === projectDir}
                    >
                      {dir}
                    </button>
                  ))}
                </div>
              )}
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

      <DirectoryBrowserModal
        open={showBrowser}
        onClose={() => setShowBrowser(false)}
        onSelect={handleBrowseSelect}
        machineId={selectedMachineId}
        initialPath={projectDir || "/"}
      />
    </>
  );
}
