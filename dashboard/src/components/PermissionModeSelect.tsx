import {
  getPermissionModeSupport,
  normalizePermissionMode,
  PERMISSION_MODE_LABELS,
  PERMISSION_MODES,
  type PermissionMode,
} from "@agent-town/shared";
import type React from "react";
import { useState } from "react";
import { getAgentTypeDisplay } from "../utils";

interface Props {
  id: string;
  agentType: string;
  value: PermissionMode;
  onChange: (mode: PermissionMode) => void;
}

const MODE_HELP: Record<string, Record<PermissionMode, string>> = {
  "claude-code": {
    default: "Use Claude Code's configured permission mode without an override. This may already be Auto.",
    auto: "Use --permission-mode auto. Claude reviews tool actions with a safety classifier; actions can still be blocked or require approval. Requires a supported model and organization policy.",
    yolo: "Use --dangerously-skip-permissions to bypass tool permission prompts. Native restrictions and managed policy may still apply.",
  },
  codex: {
    default: "Use Codex's configured approval and sandbox settings without an override.",
    auto: "Use --approve-for-me. Codex automatically reviews approval requests while keeping the workspace-write sandbox; some actions can still be denied or need your attention.",
    yolo: "Use --yolo. Bypasses approval checks and the Codex sandbox, giving tools the permissions of the process user.",
  },
  "gemini-cli": {
    default: "Use Gemini CLI's configured approval and sandbox settings without an override.",
    auto: "Use --approval-mode auto_edit. File edits are approved automatically; other tools can still prompt. This is an edit-approval policy, rather than Codex or Claude's automatic safety review.",
    yolo: "Use --yolo to approve tool actions automatically. Any separately configured sandbox remains in effect.",
  },
  opencode: {
    default: "Use OpenCode's existing permission configuration without an override.",
    auto: "OpenCode has no equivalent automatic safety-review mode.",
    yolo: "Set per-process OPENCODE_PERMISSION (v1) and OPENCODE_CLI_CONFIG_CONTENT (v2) to allow tools automatically. User config files are unchanged; specific deny rules and managed policy may still block actions.",
  },
  pi: {
    default:
      "Pi already runs tools with the process user's privileges, without per-tool approvals or a built-in sandbox. Project trust prompts and optional extensions are separate.",
    auto: "Pi has no built-in permission-review layer or separate Auto switch.",
    yolo: "Pi has no built-in permission checks to bypass or separate YOLO switch.",
  },
};

export function PermissionModeSelect({ id, agentType, value, onChange }: Props): React.JSX.Element {
  const [showHelp, setShowHelp] = useState(false);
  const label = getAgentTypeDisplay(agentType).label;
  const helpId = `${id}-help`;
  const help = Object.hasOwn(MODE_HELP, agentType) ? MODE_HELP[agentType] : undefined;
  return (
    <div className="form-group permission-mode-field">
      <div className="permission-mode-heading">
        <label className="form-label" htmlFor={id}>
          Permission mode
        </label>
        <button
          type="button"
          className="permission-mode-info"
          aria-label={`Permission mode information for ${label}`}
          aria-expanded={showHelp}
          aria-controls={helpId}
          onClick={() => setShowHelp((visible) => !visible)}
        >
          i
        </button>
      </div>
      <select
        id={id}
        className="form-select"
        value={normalizePermissionMode(agentType, value)}
        onChange={(event) => onChange(event.target.value as PermissionMode)}
        aria-describedby={helpId}
      >
        {PERMISSION_MODES.map((mode) => (
          <option key={mode} value={mode} disabled={!getPermissionModeSupport(agentType, mode).supported}>
            {PERMISSION_MODE_LABELS[mode]}
          </option>
        ))}
      </select>
      <div id={helpId} className="permission-mode-help" hidden={!showHelp}>
        <p>{label} permission modes apply when starting or resuming a session.</p>
        <dl>
          {PERMISSION_MODES.map((mode) => {
            const support = getPermissionModeSupport(agentType, mode);
            return (
              <div key={mode}>
                <dt>
                  {PERMISSION_MODE_LABELS[mode]}
                  {!support.supported && " (unavailable)"}
                </dt>
                <dd>
                  {help?.[mode] ??
                    (mode === "default"
                      ? "Use the harness's configured defaults without an override."
                      : support.reason)}
                </dd>
                {!support.supported && help?.[mode] && <dd>{support.reason}</dd>}
              </div>
            );
          })}
        </dl>
      </div>
    </div>
  );
}
