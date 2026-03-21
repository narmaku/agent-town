import {
  type AgentType,
  DEFAULT_KEYBOARD_SHORTCUTS,
  type RemoteNode,
  type Settings,
  type TerminalMultiplexer,
} from "@agent-town/shared";
import type React from "react";
import { useCallback, useEffect, useState } from "react";

import { createBrowserLogger } from "../logger";
import { API } from "../utils";

const logger = createBrowserLogger("SettingsModal");

type Tab = "appearance" | "agent" | "keyboard" | "nodes";

interface Props {
  open: boolean;
  onClose: () => void;
}

export function SettingsModal({ open, onClose }: Props): React.JSX.Element | null {
  const [tab, setTab] = useState<Tab>("appearance");
  const [settings, setSettings] = useState<Settings>({
    defaultMultiplexer: "zellij",
    defaultAgentType: "claude-code",
    zellijLayout: "agent",
    defaultModel: "",
    autoDeleteOnClose: false,
    defaultProjectDir: "",
    fontSize: "small",
    theme: "dark",
    enableKeyboardNavigation: true,
    keyboardShortcuts: { ...DEFAULT_KEYBOARD_SHORTCUTS },
  });
  const [saving, setSaving] = useState(false);

  // Nodes state
  const [nodes, setNodes] = useState<RemoteNode[]>([]);
  const [showAddForm, setShowAddForm] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; error?: string; remoteInfo?: string } | null>(null);
  const [nodeName, setNodeName] = useState("");
  const [nodeHost, setNodeHost] = useState("");
  const [nodePort, setNodePort] = useState("22");
  const [nodeUser, setNodeUser] = useState("");
  const [nodeSshKeyPath, setNodeSshKeyPath] = useState("~/.ssh/id_ed25519");
  const [nodeAgentPort, setNodeAgentPort] = useState("4681");
  const [nodeAutoConnect, setNodeAutoConnect] = useState(false);
  const [nodeEnableHooks, setNodeEnableHooks] = useState(true);

  function resetNodeForm() {
    setNodeName("");
    setNodeHost("");
    setNodePort("22");
    setNodeUser("");
    setNodeSshKeyPath("~/.ssh/id_ed25519");
    setNodeAgentPort("4681");
    setNodeAutoConnect(false);
    setNodeEnableHooks(true);
    setTestResult(null);
    setShowAddForm(false);
  }

  const loadNodes = useCallback(async () => {
    try {
      const resp = await fetch(API.NODES);
      if (resp.ok) setNodes(await resp.json());
    } catch {
      // ignore
    }
  }, []);

  useEffect(() => {
    if (open) {
      fetch(API.SETTINGS)
        .then((r) => r.json())
        .then((s: Settings) => setSettings(s))
        .catch((err) => logger.warn("Failed to load settings:", err));
      loadNodes();
    }
  }, [open, loadNodes]);

  // Poll nodes status while on nodes tab
  useEffect(() => {
    if (open && tab === "nodes") {
      const interval = setInterval(loadNodes, 3000);
      return () => clearInterval(interval);
    }
  }, [open, tab, loadNodes]);

  if (!open) return null;

  async function handleSave() {
    setSaving(true);
    try {
      const resp = await fetch(API.SETTINGS, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(settings),
      });
      if (resp.ok) onClose();
    } catch (err) {
      logger.warn("Failed to save settings:", err);
    } finally {
      setSaving(false);
    }
  }

  async function handleTestNode() {
    setTesting(true);
    setTestResult(null);
    try {
      const resp = await fetch(API.NODES_TEST, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          host: nodeHost,
          port: parseInt(nodePort, 10),
          user: nodeUser,
          sshKeyPath: nodeSshKeyPath,
        }),
      });
      setTestResult(await resp.json());
    } catch {
      setTestResult({ ok: false, error: "Failed to reach server" });
    } finally {
      setTesting(false);
    }
  }

  async function handleAddNode() {
    try {
      const resp = await fetch(API.NODES, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: nodeName,
          host: nodeHost,
          port: parseInt(nodePort, 10),
          user: nodeUser,
          sshKeyPath: nodeSshKeyPath,
          agentPort: parseInt(nodeAgentPort, 10),
          autoConnect: nodeAutoConnect,
          enableHooks: nodeEnableHooks,
        }),
      });
      if (resp.ok) {
        resetNodeForm();
        await loadNodes();
      }
    } catch {
      // ignore
    }
  }

  const SHORTCUT_ACTION_LABELS: Record<string, string> = {
    navigateDown: "Navigate down",
    navigateUp: "Navigate up",
    expandCollapse: "Expand / collapse",
    fullscreen: "Fullscreen view",
    close: "Close / back",
    focusSearch: "Focus search",
    openTerminal: "Open terminal",
    sendMessage: "Send message",
    showHelp: "Show shortcuts",
  };

  function formatShortcutAction(action: string): string {
    return SHORTCUT_ACTION_LABELS[action] || action;
  }

  function formatShortcutKey(key: string): string {
    if (key === "Escape") return "Esc";
    if (key === "Enter") return "Enter";
    if (key === " ") return "Space";
    return key;
  }

  const NODE_STATUS_COLORS: Record<string, string> = {
    disconnected: "var(--gray)",
    connecting: "var(--yellow)",
    deploying: "var(--blue)",
    connected: "var(--green)",
    error: "var(--red)",
  };

  const NODE_STATUS_LABELS: Record<string, string> = {
    disconnected: "Disconnected",
    connecting: "Connecting...",
    deploying: "Deploying...",
    connected: "Connected",
    error: "Error",
  };

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
      <div className="modal-panel settings-panel">
        <div className="modal-header">
          <h2 className="modal-title">Settings</h2>
          <button type="button" className="modal-close" onClick={onClose} aria-label="Close">
            &times;
          </button>
        </div>

        <div className="settings-tabs">
          <button
            type="button"
            className={`settings-tab ${tab === "appearance" ? "active" : ""}`}
            onClick={() => setTab("appearance")}
          >
            Appearance
          </button>
          <button
            type="button"
            className={`settings-tab ${tab === "agent" ? "active" : ""}`}
            onClick={() => setTab("agent")}
          >
            Agent Defaults
          </button>
          <button
            type="button"
            className={`settings-tab ${tab === "keyboard" ? "active" : ""}`}
            onClick={() => setTab("keyboard")}
          >
            Keyboard
          </button>
          <button
            type="button"
            className={`settings-tab ${tab === "nodes" ? "active" : ""}`}
            onClick={() => setTab("nodes")}
          >
            Remote Nodes
            {nodes.filter((n) => n.status === "connected").length > 0 && (
              <span className="tab-badge">{nodes.filter((n) => n.status === "connected").length}</span>
            )}
          </button>
        </div>

        <div className="modal-body">
          {/* --- Appearance Tab --- */}
          {tab === "appearance" && (
            <>
              <div className="form-group">
                <label className="form-label" htmlFor="settings-theme">
                  Theme
                </label>
                <select
                  id="settings-theme"
                  className="form-select"
                  value={settings.theme}
                  onChange={(e) => setSettings({ ...settings, theme: e.target.value as "dark" | "light" })}
                >
                  <option value="dark">Dark</option>
                  <option value="light">Light</option>
                </select>
              </div>
              <div className="form-group">
                <label className="form-label" htmlFor="settings-font-size">
                  Font Size
                </label>
                <select
                  id="settings-font-size"
                  className="form-select"
                  value={settings.fontSize}
                  onChange={(e) =>
                    setSettings({ ...settings, fontSize: e.target.value as "small" | "medium" | "large" })
                  }
                >
                  <option value="small">Small</option>
                  <option value="medium">Medium</option>
                  <option value="large">Large</option>
                </select>
              </div>
            </>
          )}

          {/* --- Agent Defaults Tab --- */}
          {tab === "agent" && (
            <>
              <div className="form-group">
                <label className="form-label" htmlFor="settings-agent-type">
                  Default Agent Type
                </label>
                <select
                  id="settings-agent-type"
                  className="form-select"
                  value={settings.defaultAgentType}
                  onChange={(e) => setSettings({ ...settings, defaultAgentType: e.target.value as AgentType })}
                >
                  <option value="claude-code">Claude Code</option>
                  <option value="opencode">OpenCode</option>
                </select>
              </div>
              <div className="form-group">
                <label className="form-label" htmlFor="settings-multiplexer">
                  Default Terminal Multiplexer
                </label>
                <select
                  id="settings-multiplexer"
                  className="form-select"
                  value={settings.defaultMultiplexer}
                  onChange={(e) =>
                    setSettings({ ...settings, defaultMultiplexer: e.target.value as TerminalMultiplexer })
                  }
                >
                  <option value="zellij">Zellij</option>
                  <option value="tmux">tmux</option>
                </select>
              </div>
              <div className="form-group">
                <label className="form-label" htmlFor="settings-zellij-layout">
                  Zellij Layout Name
                </label>
                <input
                  id="settings-zellij-layout"
                  className="form-input"
                  type="text"
                  value={settings.zellijLayout}
                  onChange={(e) => setSettings({ ...settings, zellijLayout: e.target.value })}
                  placeholder="agent"
                />
                <span className="form-hint">Used with zellij -n flag</span>
              </div>
              <div className="form-group">
                <label className="form-label" htmlFor="settings-model">
                  Default Model
                </label>
                <input
                  id="settings-model"
                  className="form-input"
                  type="text"
                  value={settings.defaultModel || ""}
                  onChange={(e) => setSettings({ ...settings, defaultModel: e.target.value || undefined })}
                  placeholder="e.g. opus, sonnet (optional)"
                />
              </div>
              <div className="form-group">
                <label className="form-label" htmlFor="settings-project-dir">
                  Default Project Directory
                </label>
                <input
                  id="settings-project-dir"
                  className="form-input"
                  type="text"
                  value={settings.defaultProjectDir}
                  onChange={(e) => setSettings({ ...settings, defaultProjectDir: e.target.value })}
                  placeholder="~ (home directory)"
                />
                <span className="form-hint">Pre-fills the project directory when launching new agents</span>
              </div>
              <div className="form-group">
                <label className="form-toggle-row">
                  <input
                    type="checkbox"
                    checked={settings.autoDeleteOnClose}
                    onChange={(e) => {
                      if (e.target.checked) {
                        if (
                          !window.confirm(
                            "When enabled, closing an agent will also permanently delete its conversation history. Are you sure?",
                          )
                        )
                          return;
                      }
                      setSettings({ ...settings, autoDeleteOnClose: e.target.checked });
                    }}
                  />
                  <span className="form-toggle-label">Auto-delete on close</span>
                </label>
                {settings.autoDeleteOnClose && (
                  <span className="form-hint" style={{ color: "var(--yellow)" }}>
                    Closing an agent will also delete its conversation history.
                  </span>
                )}
              </div>
            </>
          )}

          {/* --- Keyboard Tab --- */}
          {tab === "keyboard" && (
            <>
              <div className="form-group">
                <label className="form-toggle-row">
                  <input
                    type="checkbox"
                    checked={settings.enableKeyboardNavigation}
                    onChange={(e) => setSettings({ ...settings, enableKeyboardNavigation: e.target.checked })}
                  />
                  <span className="form-toggle-label">Enable keyboard navigation</span>
                </label>
                <span className="form-hint">
                  Use keyboard shortcuts to navigate sessions. Press ? to see all shortcuts.
                </span>
              </div>
              <div className="settings-section">
                <div className="settings-section-title">Shortcuts</div>
                <div className="keyboard-shortcuts-list">
                  {Object.entries(settings.keyboardShortcuts).map(([action, key]) => (
                    <div key={action} className="shortcut-row">
                      <span className="shortcut-action">{formatShortcutAction(action)}</span>
                      <kbd className="shortcut-key">{formatShortcutKey(key)}</kbd>
                    </div>
                  ))}
                </div>
              </div>
            </>
          )}

          {/* --- Remote Nodes Tab --- */}
          {tab === "nodes" && (
            <>
              {nodes.length === 0 && !showAddForm && (
                <p className="empty-hint">
                  No remote nodes configured. Add a node to monitor Claude sessions on other machines via SSH.
                </p>
              )}

              {nodes.map((node) => (
                <div key={node.id} className="node-card">
                  <div className="node-header">
                    <span
                      className="status-dot"
                      style={{ backgroundColor: NODE_STATUS_COLORS[node.status] }}
                      title={NODE_STATUS_LABELS[node.status]}
                    />
                    <strong>{node.name}</strong>
                    <span className="node-host">
                      {node.user}@{node.host}:{node.port}
                    </span>
                    <span className="node-status" style={{ color: NODE_STATUS_COLORS[node.status] }}>
                      {NODE_STATUS_LABELS[node.status]}
                    </span>
                  </div>
                  {node.error && <div className="node-error">{node.error}</div>}
                  {node.lastConnected && (
                    <div className="node-meta">Last connected: {new Date(node.lastConnected).toLocaleString()}</div>
                  )}
                  <div className="node-actions">
                    {node.status === "disconnected" || node.status === "error" ? (
                      <button
                        type="button"
                        className="action-btn resume-btn"
                        onClick={async () => {
                          await fetch(`${API.NODES}/${node.id}/connect`, { method: "POST" });
                          setTimeout(loadNodes, 1000);
                        }}
                      >
                        Connect
                      </button>
                    ) : node.status === "connected" ? (
                      <button
                        type="button"
                        className="action-btn"
                        onClick={async () => {
                          await fetch(`${API.NODES}/${node.id}/disconnect`, { method: "POST" });
                          await loadNodes();
                        }}
                      >
                        Disconnect
                      </button>
                    ) : (
                      <button type="button" className="action-btn" disabled>
                        {NODE_STATUS_LABELS[node.status]}
                      </button>
                    )}
                    <button
                      type="button"
                      className="action-btn kill-btn"
                      onClick={async () => {
                        if (!window.confirm(`Delete node "${node.name}"?`)) return;
                        await fetch(`${API.NODES}/${node.id}`, { method: "DELETE" });
                        await loadNodes();
                      }}
                    >
                      Delete
                    </button>
                  </div>
                </div>
              ))}

              {showAddForm ? (
                <div className="node-add-form">
                  <h3>Add Remote Node</h3>
                  <div className="form-group">
                    <label htmlFor="node-name" className="form-label">
                      Display Name
                    </label>
                    <input
                      id="node-name"
                      className="form-input"
                      value={nodeName}
                      onChange={(e) => setNodeName(e.target.value)}
                      placeholder="e.g., Build Server"
                    />
                  </div>
                  <div className="form-row">
                    <div className="form-group" style={{ flex: 3 }}>
                      <label htmlFor="node-host" className="form-label">
                        Host
                      </label>
                      <input
                        id="node-host"
                        className="form-input"
                        value={nodeHost}
                        onChange={(e) => setNodeHost(e.target.value)}
                        placeholder="hostname or IP"
                      />
                    </div>
                    <div className="form-group" style={{ flex: 1 }}>
                      <label htmlFor="node-port" className="form-label">
                        SSH Port
                      </label>
                      <input
                        id="node-port"
                        className="form-input"
                        value={nodePort}
                        onChange={(e) => setNodePort(e.target.value)}
                      />
                    </div>
                  </div>
                  <div className="form-group">
                    <label htmlFor="node-user" className="form-label">
                      Username
                    </label>
                    <input
                      id="node-user"
                      className="form-input"
                      value={nodeUser}
                      onChange={(e) => setNodeUser(e.target.value)}
                      placeholder="SSH username"
                    />
                  </div>
                  <div className="form-group">
                    <label htmlFor="node-key" className="form-label">
                      SSH Key Path
                    </label>
                    <input
                      id="node-key"
                      className="form-input"
                      value={nodeSshKeyPath}
                      onChange={(e) => setNodeSshKeyPath(e.target.value)}
                      placeholder="~/.ssh/id_ed25519"
                    />
                  </div>
                  <div className="form-group">
                    <label htmlFor="node-agent-port" className="form-label">
                      Agent Port (remote)
                    </label>
                    <input
                      id="node-agent-port"
                      className="form-input"
                      value={nodeAgentPort}
                      onChange={(e) => setNodeAgentPort(e.target.value)}
                    />
                  </div>
                  <div className="form-group">
                    <label className="form-label" style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
                      <input
                        type="checkbox"
                        checked={nodeAutoConnect}
                        onChange={(e) => setNodeAutoConnect(e.target.checked)}
                      />
                      Auto-connect on server start
                    </label>
                  </div>
                  <div className="form-group">
                    <label className="form-label" style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
                      <input
                        type="checkbox"
                        checked={nodeEnableHooks}
                        onChange={(e) => setNodeEnableHooks(e.target.checked)}
                      />
                      Enable Claude Code hooks (real-time status)
                    </label>
                    <span className="form-hint">
                      Configures ~/.claude/settings.json on the remote to send hook events to the agent. Provides
                      accurate status tracking (working, awaiting input, action required).
                    </span>
                  </div>
                  {testResult && (
                    <div className={`node-test-result ${testResult.ok ? "success" : "failure"}`}>
                      {testResult.ok
                        ? `Connection successful: ${testResult.remoteInfo}`
                        : `Connection failed: ${testResult.error}`}
                    </div>
                  )}
                  <div className="form-actions">
                    <button
                      type="button"
                      className="action-btn"
                      onClick={handleTestNode}
                      disabled={testing || !nodeHost || !nodeUser || !nodeSshKeyPath}
                    >
                      {testing ? "Testing..." : "Test Connection"}
                    </button>
                    <button
                      type="button"
                      className="action-btn resume-btn"
                      onClick={handleAddNode}
                      disabled={!nodeName || !nodeHost || !nodeUser || !nodeSshKeyPath}
                    >
                      Add Node
                    </button>
                    <button type="button" className="action-btn" onClick={resetNodeForm}>
                      Cancel
                    </button>
                  </div>
                </div>
              ) : (
                <div style={{ marginTop: "1rem" }}>
                  <button type="button" className="action-btn resume-btn" onClick={() => setShowAddForm(true)}>
                    + Add Node
                  </button>
                </div>
              )}
            </>
          )}
        </div>

        {(tab === "appearance" || tab === "agent" || tab === "keyboard") && (
          <div className="modal-footer">
            <button type="button" className="action-btn" onClick={onClose}>
              Cancel
            </button>
            <button type="button" className="send-btn" onClick={handleSave} disabled={saving}>
              {saving ? "Saving..." : "Save"}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
