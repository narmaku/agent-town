/** Permission overrides requested for a new or resumed harness process. */
export type PermissionMode = "default" | "auto" | "yolo";

export const PERMISSION_MODES = ["default", "auto", "yolo"] as const;
export const PERMISSION_MODE_LABELS: Record<PermissionMode, string> = {
  default: "Default",
  auto: "Auto",
  yolo: "YOLO",
};

export interface PermissionModeSupport {
  supported: boolean;
  reason?: string;
}

export function getPermissionModeSupport(agentType: string, mode: PermissionMode): PermissionModeSupport {
  if (mode === "default") return { supported: true };
  if (["claude-code", "codex", "gemini-cli"].includes(agentType)) return { supported: true };
  if (agentType === "opencode") {
    return mode === "yolo"
      ? { supported: true }
      : { supported: false, reason: "OpenCode has no equivalent automatic safety-review mode." };
  }
  return {
    supported: false,
    reason:
      agentType === "pi"
        ? "Pi has no built-in per-tool approval or sandbox layer, so there is no separate Auto or YOLO switch."
        : "This agent type is not recognized; only its configured default can be used.",
  };
}

export function normalizePermissionMode(agentType: string, mode: PermissionMode): PermissionMode {
  return getPermissionModeSupport(agentType, mode).supported ? mode : "default";
}

export interface PermissionModeInput {
  permissionMode?: unknown;
  /** @deprecated Use permissionMode. */
  autonomous?: unknown;
}

/** Validate at API/provider boundaries. Never turn malformed input into a bypass. */
export function resolvePermissionMode(input: PermissionModeInput, agentType: string): PermissionMode {
  if (input.autonomous !== undefined && typeof input.autonomous !== "boolean") {
    throw new Error("autonomous must be a boolean");
  }
  const explicit = input.permissionMode;
  if (explicit !== undefined && !PERMISSION_MODES.includes(explicit as PermissionMode)) {
    throw new Error("permissionMode must be default, auto, or yolo");
  }
  // These harnesses previously ignored autonomous. Preserve that legacy behavior.
  const legacyMode = input.autonomous && agentType !== "pi" && agentType !== "opencode" ? "yolo" : "default";
  const mode = (explicit ?? legacyMode) as PermissionMode;
  const support = getPermissionModeSupport(agentType, mode);
  if (!support.supported) throw new Error(`${PERMISSION_MODE_LABELS[mode]} is unavailable: ${support.reason}`);
  return mode;
}
