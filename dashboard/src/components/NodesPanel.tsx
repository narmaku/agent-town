import type { NodeStatus, RemoteNode } from "@agent-town/shared";
import { useCallback, useEffect, useState } from "react";
import { API } from "../utils";

const STATUS_COLORS: Record<NodeStatus, string> = {
  disconnected: "#6b7280",
  connecting: "#f59e0b",
  deploying: "#3b82f6",
  connected: "#22c55e",
  error: "#ef4444",
};

const STATUS_LABELS: Record<NodeStatus, string> = {
  disconnected: "Disconnected",
  connecting: "Connecting...",
  deploying: "Deploying...",
  connected: "Connected",
  error: "Error",
};

interface Props {
  open: boolean;
  onClose: () => void;
}

export function NodesPanel({ open, onClose }: Props) {
  const [nodes, setNodes] = useState<RemoteNode[]>([]);
  const [showAddForm, setShowAddForm] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; error?: string; remoteInfo?: string } | null>(null);

  // Form state
  const [name, setName] = useState("");
  const [host, setHost] = useState("");
  const [port, setPort] = useState("22");
  const [user, setUser] = useState("");
  const [sshKeyPath, setSshKeyPath] = useState("~/.ssh/id_ed25519");
  const [agentPort, setAgentPort] = useState("4681");
  const [autoConnect, setAutoConnect] = useState(false);

  function resetForm() {
    setName("");
    setHost("");
    setPort("22");
    setUser("");
    setSshKeyPath("~/.ssh/id_ed25519");
    setAgentPort("4681");
    setAutoConnect(false);
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
      loadNodes();
      const interval = setInterval(loadNodes, 3000);
      return () => clearInterval(interval);
    }
  }, [open, loadNodes]);

  if (!open) return null;

  async function handleTest() {
    setTesting(true);
    setTestResult(null);
    try {
      const resp = await fetch(API.NODES_TEST, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          host,
          port: parseInt(port, 10),
          user,
          sshKeyPath,
        }),
      });
      const result = await resp.json();
      setTestResult(result);
    } catch {
      setTestResult({ ok: false, error: "Failed to reach server" });
    } finally {
      setTesting(false);
    }
  }

  async function handleAdd() {
    try {
      const resp = await fetch(API.NODES, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name,
          host,
          port: parseInt(port, 10),
          user,
          sshKeyPath,
          agentPort: parseInt(agentPort, 10),
          autoConnect,
        }),
      });
      if (resp.ok) {
        resetForm();
        await loadNodes();
      }
    } catch {
      // ignore
    }
  }

  async function handleConnect(nodeId: string) {
    await fetch(`${API.NODES}/${nodeId}/connect`, { method: "POST" });
    setTimeout(loadNodes, 1000);
  }

  async function handleDisconnect(nodeId: string) {
    await fetch(`${API.NODES}/${nodeId}/disconnect`, { method: "POST" });
    await loadNodes();
  }

  async function handleDelete(nodeId: string, nodeName: string) {
    if (!window.confirm(`Delete node "${nodeName}"? This will disconnect it if connected.`)) return;
    await fetch(`${API.NODES}/${nodeId}`, { method: "DELETE" });
    await loadNodes();
  }

  function handleOverlayClick(e: React.MouseEvent) {
    if (e.target === e.currentTarget) onClose();
  }

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: modal overlay dismissal
    <div
      className="modal-overlay"
      onClick={handleOverlayClick}
      onKeyDown={(e) => {
        if (e.key === "Escape") onClose();
      }}
      role="presentation"
    >
      <div className="modal-panel" style={{ maxWidth: 700 }}>
        <div className="modal-header">
          <h2>Remote Nodes</h2>
          <button type="button" className="modal-close" onClick={onClose} aria-label="Close">
            x
          </button>
        </div>

        <div className="modal-body">
          {nodes.length === 0 && !showAddForm && (
            <p style={{ color: "#9ca3af", textAlign: "center", padding: "2rem 0" }}>
              No remote nodes configured. Add a node to monitor Claude sessions on other machines via SSH.
            </p>
          )}

          {nodes.map((node) => (
            <div key={node.id} className="node-card">
              <div className="node-header">
                <span
                  className="status-dot"
                  style={{ backgroundColor: STATUS_COLORS[node.status] }}
                  title={STATUS_LABELS[node.status]}
                />
                <strong>{node.name}</strong>
                <span className="node-host">
                  {node.user}@{node.host}:{node.port}
                </span>
                <span className="node-status" style={{ color: STATUS_COLORS[node.status] }}>
                  {STATUS_LABELS[node.status]}
                </span>
              </div>
              {node.error && <div className="node-error">{node.error}</div>}
              {node.lastConnected && (
                <div className="node-meta">Last connected: {new Date(node.lastConnected).toLocaleString()}</div>
              )}
              <div className="node-actions">
                {node.status === "disconnected" || node.status === "error" ? (
                  <button type="button" className="action-btn resume-btn" onClick={() => handleConnect(node.id)}>
                    Connect
                  </button>
                ) : node.status === "connected" ? (
                  <button type="button" className="action-btn" onClick={() => handleDisconnect(node.id)}>
                    Disconnect
                  </button>
                ) : (
                  <button type="button" className="action-btn" disabled>
                    {STATUS_LABELS[node.status]}
                  </button>
                )}
                <button type="button" className="action-btn kill-btn" onClick={() => handleDelete(node.id, node.name)}>
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
                  value={name}
                  onChange={(e) => setName(e.target.value)}
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
                    value={host}
                    onChange={(e) => setHost(e.target.value)}
                    placeholder="hostname or IP"
                  />
                </div>
                <div className="form-group" style={{ flex: 1 }}>
                  <label htmlFor="node-port" className="form-label">
                    SSH Port
                  </label>
                  <input id="node-port" className="form-input" value={port} onChange={(e) => setPort(e.target.value)} />
                </div>
              </div>
              <div className="form-group">
                <label htmlFor="node-user" className="form-label">
                  Username
                </label>
                <input
                  id="node-user"
                  className="form-input"
                  value={user}
                  onChange={(e) => setUser(e.target.value)}
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
                  value={sshKeyPath}
                  onChange={(e) => setSshKeyPath(e.target.value)}
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
                  value={agentPort}
                  onChange={(e) => setAgentPort(e.target.value)}
                />
              </div>
              <div className="form-group">
                <label className="form-label" style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
                  <input type="checkbox" checked={autoConnect} onChange={(e) => setAutoConnect(e.target.checked)} />
                  Auto-connect on server start
                </label>
              </div>

              {testResult && (
                <div className={`node-test-result ${testResult.ok ? "success" : "failure"}`}>
                  {testResult.ok ? (
                    <span>Connection successful: {testResult.remoteInfo}</span>
                  ) : (
                    <span>Connection failed: {testResult.error}</span>
                  )}
                </div>
              )}

              <div className="form-actions">
                <button
                  type="button"
                  className="action-btn"
                  onClick={handleTest}
                  disabled={testing || !host || !user || !sshKeyPath}
                >
                  {testing ? "Testing..." : "Test Connection"}
                </button>
                <button
                  type="button"
                  className="action-btn resume-btn"
                  onClick={handleAdd}
                  disabled={!name || !host || !user || !sshKeyPath}
                >
                  Add Node
                </button>
                <button type="button" className="action-btn" onClick={resetForm}>
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
        </div>
      </div>
    </div>
  );
}
