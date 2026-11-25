import {
  getPermissionModeSupport,
  normalizePermissionMode,
  PERMISSION_MODE_LABELS,
  PERMISSION_MODES,
  type PermissionMode,
} from "@agent-town/shared";
import type React from "react";
import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
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

interface HelpProps {
  id: string;
  label: string;
  text: string;
  visible: boolean;
  onShow: () => void;
  onHide: () => void;
}

function ModeHelp({ id, label, text, visible, onShow, onHide }: HelpProps): React.JSX.Element {
  const [position, setPosition] = useState({ left: 0, top: 0 });
  const buttonRef = useRef<HTMLButtonElement>(null);
  const tooltipRef = useRef<HTMLSpanElement>(null);

  useLayoutEffect(() => {
    if (!visible || !buttonRef.current || !tooltipRef.current) return;
    const button = buttonRef.current.getBoundingClientRect();
    const tooltip = tooltipRef.current.getBoundingClientRect();
    const margin = 12;
    const left = Math.max(
      margin,
      Math.min(button.left + button.width / 2 - tooltip.width / 2, window.innerWidth - tooltip.width - margin),
    );
    const above = button.top - tooltip.height - 8;
    const top = above >= margin ? above : Math.min(button.bottom + 8, window.innerHeight - tooltip.height - margin);
    setPosition({ left, top: Math.max(margin, top) });
  }, [visible]);

  useEffect(() => {
    if (!visible) return;
    const dismiss = () => onHide();
    const onPointerDown = (event: PointerEvent) => {
      if (!buttonRef.current?.contains(event.target as Node) && !tooltipRef.current?.contains(event.target as Node))
        dismiss();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      dismiss();
    };
    window.addEventListener("resize", dismiss);
    window.addEventListener("scroll", dismiss, true);
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown, true);
    return () => {
      window.removeEventListener("resize", dismiss);
      window.removeEventListener("scroll", dismiss, true);
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown, true);
    };
  }, [visible, onHide]);

  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        className="permission-mode-info"
        aria-label={label}
        aria-describedby={id}
        onMouseEnter={onShow}
        onMouseLeave={(event) => {
          if (document.activeElement !== event.currentTarget) onHide();
        }}
        onFocus={onShow}
        onBlur={onHide}
        onPointerDown={(event) => {
          if (event.pointerType === "touch") event.currentTarget.focus();
        }}
      >
        i
      </button>
      <span
        ref={tooltipRef}
        id={id}
        role="tooltip"
        className="permission-mode-tooltip"
        hidden={!visible}
        style={position}
      >
        {text}
      </span>
    </>
  );
}

export function PermissionModeSelect({ id, agentType, value, onChange }: Props): React.JSX.Element {
  const instanceId = useId();
  const [activeHelp, setActiveHelp] = useState<{ agentType: string; mode: PermissionMode } | null>(null);
  useEffect(() => {
    setActiveHelp((current) => (current?.agentType === agentType ? current : null));
  }, [agentType]);
  const groupId = `${id}-${instanceId}`;
  const label = getAgentTypeDisplay(agentType).label;
  const help = Object.hasOwn(MODE_HELP, agentType) ? MODE_HELP[agentType] : undefined;
  const selected = normalizePermissionMode(agentType, value);
  return (
    <fieldset className="form-group permission-mode-field">
      <legend className="form-label">Permission mode</legend>
      <div className="permission-mode-options">
        {PERMISSION_MODES.map((mode) => {
          const support = getPermissionModeSupport(agentType, mode);
          const optionId = `${groupId}-${mode}`;
          const explanation =
            help?.[mode] ??
            (mode === "default"
              ? "Use the harness's configured defaults without an override."
              : (support.reason ?? "This mode is unavailable."));
          const text =
            !support.supported && support.reason && support.reason !== explanation
              ? `${explanation} ${support.reason}`
              : explanation;
          return (
            <div className="permission-mode-option" key={mode}>
              <label className="permission-mode-label" htmlFor={optionId}>
                <input
                  id={optionId}
                  type="radio"
                  name={groupId}
                  disabled={!support.supported}
                  value={mode}
                  checked={selected === mode}
                  onChange={() => onChange(mode)}
                />
                {PERMISSION_MODE_LABELS[mode]}
              </label>
              <ModeHelp
                key={agentType}
                id={`${optionId}-help`}
                label={`About ${PERMISSION_MODE_LABELS[mode]} mode for ${label}`}
                text={text}
                visible={activeHelp?.agentType === agentType && activeHelp.mode === mode}
                onShow={() => setActiveHelp({ agentType, mode })}
                onHide={() =>
                  setActiveHelp((current) =>
                    current?.agentType === agentType && current.mode === mode ? null : current,
                  )
                }
              />
            </div>
          );
        })}
      </div>
    </fieldset>
  );
}
