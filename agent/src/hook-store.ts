import { createLogger, type SessionStatus, truncateId } from "@agent-town/shared";
import type { HookEventResult } from "./providers/types";

const log = createLogger("hook-store");

// How long before a hook session is considered stale (no events received).
// After this, we fall back to JSONL heuristics.
const STALE_THRESHOLD_MS = 60_000;

export interface HookSessionState {
  sessionId: string;
  status: SessionStatus;
  lastEvent: string;
  lastEventTime: number;
  currentTool?: string;
}

// In-memory store: session_id → latest state (provider-agnostic)
const sessions = new Map<string, HookSessionState>();

/**
 * Update hook state from a normalized event result.
 * Called by providers after translating their native event format.
 */
export function updateHookState(result: HookEventResult): void {
  const { sessionId, status, currentTool } = result;
  if (!sessionId) return;

  sessions.set(sessionId, {
    sessionId,
    status,
    lastEvent: status,
    lastEventTime: Date.now(),
    currentTool,
  });

  log.debug(`hook: session=${truncateId(sessionId)} status=${status}${currentTool ? ` tool=${currentTool}` : ""}`);
}

/**
 * Get hook-based status for a session.
 * Returns undefined if no hook data or data is stale.
 */
export function getHookState(sessionId: string): HookSessionState | undefined {
  const state = sessions.get(sessionId);
  if (!state) return undefined;
  const elapsed = Date.now() - state.lastEventTime;
  // Expire transient states (working) after 60s without events.
  // "done" does NOT expire — it persists until the session is
  // resumed (SessionStart clears it) or deleted (clearHookSession).
  if (elapsed > STALE_THRESHOLD_MS && state.status === "working") return undefined;
  return state;
}

/**
 * Clear hook state for a specific session.
 * Called when a session is deleted or its state should be reset.
 */
export function clearHookSession(sessionId: string): void {
  sessions.delete(sessionId);
}

/**
 * Get all tracked sessions (for debugging/testing).
 */
export function getAllHookSessions(): Map<string, HookSessionState> {
  return sessions;
}

/**
 * Clear all hook sessions (for testing).
 */
export function clearHookSessions(): void {
  sessions.clear();
}
