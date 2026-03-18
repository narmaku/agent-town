import { createLogger, type SessionStatus } from "@agent-town/shared";
import type { HookEventResult } from "../types";
import { getOpenCodeClient, resetOpenCodeClient } from "./sdk-client";

const log = createLogger("opencode:events");

// --- Webhook-based event handling (legacy / fallback) ---

interface OpenCodeWebhookEvent {
  session_id: string;
  event_type: string;
  tool_name?: string;
  agent_type: "opencode";
}

function isOpenCodeWebhookEvent(payload: unknown): payload is OpenCodeWebhookEvent {
  if (typeof payload !== "object" || payload === null) return false;
  const p = payload as Record<string, unknown>;
  return p.agent_type === "opencode" && typeof p.session_id === "string" && typeof p.event_type === "string";
}

/** Parse a webhook event and return normalized status. */
export function handleOpenCodeEvent(payload: unknown): HookEventResult | null {
  if (!isOpenCodeWebhookEvent(payload)) return null;

  const { session_id, event_type, tool_name } = payload;
  if (!session_id) return null;

  let status: SessionStatus;
  let currentTool: string | undefined;

  switch (event_type) {
    case "session.created":
    case "session.idle":
      status = "awaiting_input";
      break;
    case "session.deleted":
      status = "done";
      break;
    case "session.error":
      status = "error";
      break;
    case "tool.execute.before":
      status = "working";
      currentTool = tool_name;
      break;
    case "tool.execute.after":
      status = "working";
      break;
    case "message.updated":
      status = "working";
      break;
    case "permission.asked":
      status = "action_required";
      break;
    case "permission.replied":
      status = "working";
      break;
    default:
      return null;
  }

  return { sessionId: session_id, status, currentTool };
}

// --- SDK SSE event subscription ---

let sseActive = false;

/**
 * Start subscribing to OpenCode SSE events for real-time status updates.
 * Returns a callback for updating hook state with each event.
 */
export async function startOpenCodeEventStream(onEvent: (result: HookEventResult) => void): Promise<void> {
  if (sseActive) return;

  const client = await getOpenCodeClient();
  if (!client) return;

  sseActive = true;
  log.info("starting SSE event subscription");

  try {
    const { data: eventStream } = await client.event.subscribe();
    if (!eventStream) {
      sseActive = false;
      return;
    }

    // Process events in background
    (async () => {
      try {
        for await (const event of eventStream) {
          const result = mapSSEEvent(event);
          if (result) {
            onEvent(result);
          }
        }
      } catch (err) {
        log.warn(`SSE stream ended: ${err instanceof Error ? err.message : String(err)}`);
        resetOpenCodeClient();
      } finally {
        sseActive = false;
        log.debug("SSE event subscription ended");
      }
    })();
  } catch (err) {
    sseActive = false;
    log.debug(`SSE subscribe failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

interface SSEEvent {
  type: string;
  properties?: Record<string, unknown>;
}

function mapSSEEvent(event: SSEEvent): HookEventResult | null {
  const sessionId = (event.properties?.sessionID as string) || "";
  if (!sessionId) return null;

  switch (event.type) {
    case "session.status": {
      const status = event.properties?.status as { type: string } | undefined;
      if (status?.type === "busy") return { sessionId, status: "working" };
      if (status?.type === "idle") return { sessionId, status: "awaiting_input" };
      if (status?.type === "retry") return { sessionId, status: "working" };
      return null;
    }
    case "session.idle":
      return { sessionId, status: "awaiting_input" };
    case "session.error":
      return { sessionId, status: "error" };
    case "session.created":
      return { sessionId, status: "awaiting_input" };
    case "session.deleted":
      return { sessionId, status: "done" };
    case "message.part.updated": {
      // If a part is being updated, the agent is working
      return { sessionId, status: "working" };
    }
    case "permission.updated":
      return { sessionId, status: "action_required" };
    case "permission.replied":
      return { sessionId, status: "working" };
    default:
      return null;
  }
}

export function isSSEActive(): boolean {
  return sseActive;
}
