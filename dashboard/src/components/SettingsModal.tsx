import { useState, useEffect } from "react";
import type { Settings, TerminalMultiplexer } from "@agent-town/shared";

interface Props {
  open: boolean;
  onClose: () => void;
}

export function SettingsModal({ open, onClose }: Props) {
  const [settings, setSettings] = useState<Settings>({
    defaultMultiplexer: "zellij",
    zellijLayout: "agent",
    defaultModel: "",
  });
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (open) {
      fetch("/api/settings")
        .then((r) => r.json())
        .then((s: Settings) => setSettings(s))
        .catch(() => {});
    }
  }, [open]);

  if (!open) return null;

  async function handleSave() {
    setSaving(true);
    try {
      const resp = await fetch("/api/settings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(settings),
      });
      if (resp.ok) {
        onClose();
      }
    } catch {
      // ignore
    } finally {
      setSaving(false);
    }
  }

  function handleOverlayClick(e: React.MouseEvent) {
    if (e.target === e.currentTarget) onClose();
  }

  return (
    <div className="modal-overlay" onClick={handleOverlayClick}>
      <div className="modal-panel">
        <div className="modal-header">
          <h2 className="modal-title">Settings</h2>
          <button className="modal-close" onClick={onClose}>
            &times;
          </button>
        </div>
        <div className="modal-body">
          <div className="form-group">
            <label className="form-label">Default Terminal Multiplexer</label>
            <select
              className="form-select"
              value={settings.defaultMultiplexer}
              onChange={(e) =>
                setSettings({
                  ...settings,
                  defaultMultiplexer: e.target.value as TerminalMultiplexer,
                })
              }
            >
              <option value="zellij">Zellij</option>
              <option value="tmux">tmux</option>
            </select>
          </div>
          <div className="form-group">
            <label className="form-label">Zellij Layout Name</label>
            <input
              className="form-input"
              type="text"
              value={settings.zellijLayout}
              onChange={(e) =>
                setSettings({ ...settings, zellijLayout: e.target.value })
              }
              placeholder="agent"
            />
            <span className="form-hint">Used with zellij -n flag</span>
          </div>
          <div className="form-group">
            <label className="form-label">Default Claude Code Model</label>
            <input
              className="form-input"
              type="text"
              value={settings.defaultModel || ""}
              onChange={(e) =>
                setSettings({
                  ...settings,
                  defaultModel: e.target.value || undefined,
                })
              }
              placeholder="e.g. opus, sonnet (optional)"
            />
          </div>
        </div>
        <div className="modal-footer">
          <button className="action-btn" onClick={onClose}>
            Cancel
          </button>
          <button
            className="send-btn"
            onClick={handleSave}
            disabled={saving}
          >
            {saving ? "Saving..." : "Save"}
          </button>
        </div>
      </div>
    </div>
  );
}
