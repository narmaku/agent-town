import type { SessionStatus } from "@agent-town/shared";
import type { HookEventResult } from "../types";

/**
 * OpenCode plugin events can be forwarded to Agent Town via HTTP POST.
 *
 * The event payload is expected to follow this structure:
 * {
 *   session_id: string,
 *   event_type: string,        // e.g., "session.idle", "tool.execute.before"
 *   tool_name?: string,
 *   agent_type: "opencode"     // discriminator
 * }
 *
 * This handler normalizes OpenCode events into Agent Town's SessionStatus.
 */

interface OpenCodeEvent {
  session_id: string;
  event_type: string;
  tool_name?: string;
  agent_type: "opencode";
}

function isOpenCodeEvent(payload: unknown): payload is OpenCodeEvent {
  if (typeof payload !== "object" || payload === null) return false;
  const p = payload as Record<string, unknown>;
  return p.agent_type === "opencode" && typeof p.session_id === "string" && typeof p.event_type === "string";
}

/** Parse an OpenCode plugin event and return a normalized status update. */
export function handleOpenCodeEvent(payload: unknown): HookEventResult | null {
  if (!isOpenCodeEvent(payload)) return null;

  const { session_id, event_type, tool_name } = payload;
  if (!session_id) return null;

  let status: SessionStatus;
  let currentTool: string | undefined;

  switch (event_type) {
    // Session lifecycle
    case "session.created":
      status = "awaiting_input";
      break;

    case "session.idle":
      status = "awaiting_input";
      break;

    case "session.deleted":
      status = "done";
      break;

    case "session.error":
      status = "error";
      break;

    // Tool execution
    case "tool.execute.before":
      status = "working";
      currentTool = tool_name;
      break;

    case "tool.execute.after":
      status = "working";
      currentTool = undefined;
      break;

    // Messages
    case "message.updated":
      status = "working";
      break;

    // Permissions
    case "permission.asked":
      status = "action_required";
      break;

    case "permission.replied":
      status = "working";
      break;

    default:
      // Unknown event — don't change status
      return null;
  }

  return { sessionId: session_id, status, currentTool };
}
