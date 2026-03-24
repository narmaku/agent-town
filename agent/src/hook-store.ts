import { createLogger, type SessionStatus, truncateId } from "@agent-town/shared";
import type { HookEventResult } from "./providers/types";

const log = createLogger("hook-store");

// How long before a hook session is considered stale (no events received).
// After this, we fall back to JSONL heuristics.
const STALE_THRESHOLD_MS = 60_000;

/** How long a "done" session is retained before automatic cleanup (5 minutes). */
export const DONE_EXPIRY_MS = 5 * 60 * 1000;

/** How long any session (regardless of status) is retained without events (10 minutes). */
export const MAX_STALE_MS = 10 * 60 * 1000;

/** How often the periodic cleanup runs (1 minute). */
const CLEANUP_INTERVAL_MS = 60_000;

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

/**
 * Remove expired sessions from the in-memory store.
 * - "done" sessions older than DONE_EXPIRY_MS are removed.
 * - Any session with no events for longer than MAX_STALE_MS is removed.
 */
export function pruneExpiredSessions(): void {
  const now = Date.now();
  let pruned = 0;

  for (const [id, state] of sessions) {
    const elapsed = now - state.lastEventTime;
    const isDoneExpired = state.status === "done" && elapsed > DONE_EXPIRY_MS;
    const isStale = elapsed > MAX_STALE_MS;

    if (isDoneExpired || isStale) {
      sessions.delete(id);
      pruned++;
    }
  }

  if (pruned > 0) {
    log.debug(`pruned ${pruned} expired hook session(s)`);
  }
}

// Periodic cleanup timer — unref'd so it doesn't prevent process shutdown.
const cleanupTimer = setInterval(pruneExpiredSessions, CLEANUP_INTERVAL_MS);
cleanupTimer.unref();
