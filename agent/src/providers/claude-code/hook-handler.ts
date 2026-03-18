import type { SessionStatus } from "@agent-town/shared";
import type { HookEventResult } from "../types";

interface ClaudeHookEvent {
  session_id: string;
  hook_event_name: string;
  tool_name?: string;
  notification_type?: string;
}

function isClaudeHookEvent(payload: unknown): payload is ClaudeHookEvent {
  if (typeof payload !== "object" || payload === null) return false;
  const p = payload as Record<string, unknown>;
  return typeof p.session_id === "string" && typeof p.hook_event_name === "string";
}

/** Parse a Claude Code webhook payload and return a normalized status update. */
export function handleClaudeHookEvent(payload: unknown): HookEventResult | null {
  if (!isClaudeHookEvent(payload)) return null;

  const { session_id, hook_event_name, tool_name, notification_type } = payload;
  if (!session_id) return null;

  let status: SessionStatus;
  let currentTool: string | undefined;

  switch (hook_event_name) {
    case "UserPromptSubmit":
      status = "working";
      break;

    case "PreToolUse":
      status = "working";
      currentTool = tool_name;
      break;

    case "PostToolUse":
    case "PostToolUseFailure":
      status = "working";
      currentTool = undefined;
      break;

    case "Stop":
      status = "awaiting_input";
      currentTool = undefined;
      break;

    case "Notification":
      if (notification_type === "permission_prompt" || notification_type === "question") {
        status = "action_required";
      } else {
        status = "awaiting_input";
      }
      break;

    case "SessionStart":
      status = "awaiting_input";
      break;

    case "SessionEnd":
      status = "done";
      currentTool = undefined;
      break;

    default:
      status = "awaiting_input";
      break;
  }

  return { sessionId: session_id, status, currentTool };
}
