import { type AgentType, type PermissionModeInput, resolvePermissionMode } from "@agent-town/shared";

/** Flags shared by direct commands and Claude's recovery wrapper. */
export function permissionModeArgs(agentType: AgentType, options: PermissionModeInput): string[] {
  const mode = resolvePermissionMode(options, agentType);
  if (mode === "default") return [];
  switch (agentType) {
    case "claude-code":
      return mode === "auto" ? ["--permission-mode", "auto"] : ["--dangerously-skip-permissions"];
    case "codex":
      return mode === "auto" ? ["--approve-for-me"] : ["--yolo"];
    case "gemini-cli":
      return mode === "auto" ? ["--approval-mode", "auto_edit"] : ["--yolo"];
    default:
      return [];
  }
}

export function applyPermissionMode(agentType: AgentType, command: string[], options: PermissionModeInput): string[] {
  const mode = resolvePermissionMode(options, agentType);
  if (agentType === "opencode" && mode === "yolo") {
    // Each supported OpenCode generation reads its own variable. Neither changes user config.
    return [
      "env",
      'OPENCODE_PERMISSION={"*":"allow"}',
      'OPENCODE_CLI_CONFIG_CONTENT={"session":{"permissions":"autoaccept"}}',
      ...command,
    ];
  }
  return [...command, ...permissionModeArgs(agentType, { permissionMode: mode })];
}
