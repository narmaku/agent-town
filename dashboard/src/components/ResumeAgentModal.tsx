import {
  type AgentType,
  normalizePermissionMode,
  type PermissionMode,
  parseLaunchArguments,
  type ResumeAgentRequest,
  resolveExtraLaunchArgs,
  shellEscape,
} from "@agent-town/shared";
import type React from "react";
import { useEffect, useRef, useState } from "react";
import { apiFetch } from "../auth";
import { loadLastPermissionMode, saveLastPermissionMode } from "../launch-preferences";
import { API } from "../utils";

import { PermissionModeSelect } from "./PermissionModeSelect";

const ORIGINAL_ARGUMENTS_TIMEOUT_MS = 5000;

interface Props {
  onClose: () => void;
  sessionId: string;
  sessionName?: string;
  projectDir: string;
  machineId: string;
  agentType: AgentType;
  onResumeAndConnect?: () => void;
}

export function ResumeAgentModal({
  onClose,
  sessionId,
  sessionName,
  projectDir,
  machineId,
  agentType,
  onResumeAndConnect,
}: Props): React.JSX.Element {
  const [permissionMode, setPermissionMode] = useState<PermissionMode>("default");
  const [argumentInput, setArgumentInput] = useState("");
  const [loadingArguments, setLoadingArguments] = useState(true);
  const [argumentLoadFailed, setArgumentLoadFailed] = useState(false);
  const [resuming, setResuming] = useState(false);
  const [error, setError] = useState("");
  const openingRef = useRef(0);
  const connectAfterResume = onResumeAndConnect !== undefined;
  const effectivePermissionMode = connectAfterResume ? "default" : normalizePermissionMode(agentType, permissionMode);
  useEffect(() => {
    openingRef.current++;
    if (!connectAfterResume) setPermissionMode(loadLastPermissionMode(agentType));
    setArgumentInput("");
    setLoadingArguments(true);
    setArgumentLoadFailed(false);
    setError("");
    setResuming(false);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), ORIGINAL_ARGUMENTS_TIMEOUT_MS);
    let closed = false;
    const params = new URLSearchParams({ machineId, sessionId, agentType });
    apiFetch(`${API.AGENTS_RESUME}?${params}`, { signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error(`Could not load launch arguments: ${response.status}`);
        const { extraArgs } = (await response.json()) as { extraArgs?: unknown };
        if (!closed) {
          setArgumentInput((resolveExtraLaunchArgs(extraArgs) ?? []).map(shellEscape).join(" "));
        }
      })
      .catch(() => {
        if (!closed) setArgumentLoadFailed(true);
      })
      .finally(() => {
        clearTimeout(timeout);
        if (!closed) setLoadingArguments(false);
      });
    return () => {
      closed = true;
      clearTimeout(timeout);
      controller.abort();
      openingRef.current++;
    };
  }, [agentType, machineId, sessionId, connectAfterResume]);

  async function handleResume() {
    if (resuming || loadingArguments) return;
    let extraArgs: string[];
    try {
      extraArgs = parseLaunchArguments(argumentInput);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Invalid extra arguments");
      return;
    }
    const opening = openingRef.current;
    const submittedMode = effectivePermissionMode;
    const submitted: ResumeAgentRequest = {
      machineId,
      sessionId,
      projectDir,
      permissionMode: submittedMode,
      agentType,
      extraArgs: extraArgs.length ? extraArgs : undefined,
    };
    setResuming(true);
    setError("");
    try {
      const resp = await apiFetch(API.AGENTS_RESUME, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(submitted),
      });

      if (resp.ok) {
        if (!connectAfterResume) saveLastPermissionMode(submittedMode);
        if (openingRef.current === opening) {
          setError("");
          onResumeAndConnect?.();
          onClose();
        }
      } else {
        const data = await resp.json().catch(() => ({ error: "Resume failed" }));
        if (openingRef.current === opening) setError(data.error || "Resume failed");
      }
    } catch (_err) {
      if (openingRef.current === opening) setError("Failed to connect to server");
    } finally {
      if (openingRef.current === opening) setResuming(false);
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
          <button type="button" className="modal-close" onClick={onClose} aria-label="Close resume dialog">
            &times;
          </button>
        </div>
        <div className="modal-body">
          <div className="form-group">
            <label className="form-label" htmlFor="resume-session">
              Session
            </label>
            <input
              id="resume-session"
              className="form-input"
              type="text"
              value={sessionName || sessionId.slice(0, 8)}
              disabled
            />
          </div>
          <div className="form-group">
            <label className="form-label" htmlFor="resume-project-dir">
              Project Directory
            </label>
            <input
              id="resume-project-dir"
              className="form-input form-input-readonly"
              type="text"
              value={projectDir}
              readOnly
              aria-label="Project directory (read-only)"
            />
          </div>
          {!connectAfterResume && (
            <PermissionModeSelect
              id="resume-permission-mode"
              agentType={agentType}
              value={effectivePermissionMode}
              onChange={setPermissionMode}
            />
          )}
          <div className="form-group">
            <label className="form-label" htmlFor="resume-extra-args">
              Extra Arguments (optional)
            </label>
            <input
              id="resume-extra-args"
              className="form-input"
              type="text"
              value={argumentInput}
              onChange={(e) => setArgumentInput(e.target.value)}
              placeholder={loadingArguments ? "Loading original arguments…" : '--flag "value with spaces"'}
              aria-describedby="resume-extra-args-hint"
              autoComplete="off"
              spellCheck={false}
              disabled={loadingArguments || resuming}
            />
            <span className="form-hint" id="resume-extra-args-hint">
              {argumentLoadFailed
                ? "Could not load original arguments. You can enter them manually."
                : "Edit the original launch arguments or clear the field to resume without them."}
            </span>
          </div>
          {error && <div className="form-error">{error}</div>}
        </div>
        <div className="modal-footer">
          <button type="button" className="action-btn" onClick={onClose}>
            Cancel
          </button>
          <button type="button" className="send-btn" onClick={handleResume} disabled={resuming || loadingArguments}>
            {resuming ? "Resuming..." : connectAfterResume ? "Resume & Connect" : "Resume"}
          </button>
        </div>
      </div>
    </div>
  );
}
