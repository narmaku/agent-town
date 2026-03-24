import { beforeEach, describe, expect, test } from "bun:test";
import {
  clearHookSessions,
  DONE_EXPIRY_MS,
  getAllHookSessions,
  getHookState,
  MAX_STALE_MS,
  pruneExpiredSessions,
  updateHookState,
} from "./hook-store";
import { handleClaudeHookEvent } from "./providers/claude-code/hook-handler";

/** Helper: process a Claude Code hook event through the full pipeline. */
function processHookEvent(event: {
  session_id: string;
  hook_event_name: string;
  tool_name?: string;
  notification_type?: string;
}): void {
  const result = handleClaudeHookEvent(event);
  if (result) updateHookState(result);
}

describe("pruneExpiredSessions — edge cases", () => {
  beforeEach(() => {
    clearHookSessions();
  });

  test("does nothing on an empty session map", () => {
    const sessions = getAllHookSessions();
    expect(sessions.size).toBe(0);
    pruneExpiredSessions();
    expect(sessions.size).toBe(0);
  });

  test("getHookState returns undefined for pruned sessions", () => {
    processHookEvent({ session_id: "s1", hook_event_name: "SessionEnd" });
    expect(getHookState("s1")?.status).toBe("done");

    const sessions = getAllHookSessions();
    const entry = sessions.get("s1");
    if (entry) {
      entry.lastEventTime = Date.now() - DONE_EXPIRY_MS - 1;
    }

    pruneExpiredSessions();
    expect(getHookState("s1")).toBeUndefined();
  });

  test("working session between DONE_EXPIRY_MS and MAX_STALE_MS is not pruned", () => {
    processHookEvent({ session_id: "s1", hook_event_name: "UserPromptSubmit" });
    expect(getHookState("s1")?.status).toBe("working");

    const sessions = getAllHookSessions();
    const entry = sessions.get("s1");
    if (entry) {
      // Set time to be past DONE_EXPIRY_MS but within MAX_STALE_MS
      entry.lastEventTime = Date.now() - DONE_EXPIRY_MS - 1;
    }

    pruneExpiredSessions();
    // The session should still exist in the map even though getHookState
    // returns undefined for stale working sessions (that's a separate concern)
    expect(sessions.has("s1")).toBe(true);
  });

  test("done session at exactly DONE_EXPIRY_MS boundary is not pruned", () => {
    processHookEvent({ session_id: "s1", hook_event_name: "SessionEnd" });

    const sessions = getAllHookSessions();
    const entry = sessions.get("s1");
    if (entry) {
      // Set exactly at the boundary — elapsed === DONE_EXPIRY_MS, not > DONE_EXPIRY_MS
      entry.lastEventTime = Date.now() - DONE_EXPIRY_MS;
    }

    pruneExpiredSessions();
    expect(sessions.has("s1")).toBe(true);
  });

  test("session at exactly MAX_STALE_MS boundary is not pruned", () => {
    processHookEvent({ session_id: "s1", hook_event_name: "Stop" });

    const sessions = getAllHookSessions();
    const entry = sessions.get("s1");
    if (entry) {
      entry.lastEventTime = Date.now() - MAX_STALE_MS;
    }

    pruneExpiredSessions();
    expect(sessions.has("s1")).toBe(true);
  });

  test("session refreshed by new event is not pruned even if previously stale", () => {
    processHookEvent({ session_id: "s1", hook_event_name: "SessionEnd" });

    const sessions = getAllHookSessions();
    const entry = sessions.get("s1");
    if (entry) {
      entry.lastEventTime = Date.now() - DONE_EXPIRY_MS - 1;
    }

    // Session gets a new event (resumed), updating its lastEventTime
    processHookEvent({ session_id: "s1", hook_event_name: "SessionStart" });
    expect(getHookState("s1")?.status).toBe("awaiting_input");

    pruneExpiredSessions();
    expect(sessions.has("s1")).toBe(true);
  });

  test("pruning is idempotent — calling twice does not remove extra sessions", () => {
    processHookEvent({ session_id: "s1", hook_event_name: "SessionEnd" });
    processHookEvent({ session_id: "s2", hook_event_name: "UserPromptSubmit" });

    const sessions = getAllHookSessions();
    const entry = sessions.get("s1");
    if (entry) {
      entry.lastEventTime = Date.now() - DONE_EXPIRY_MS - 1;
    }

    pruneExpiredSessions();
    expect(sessions.size).toBe(1);
    expect(sessions.has("s2")).toBe(true);

    // Second call should not remove anything else
    pruneExpiredSessions();
    expect(sessions.size).toBe(1);
    expect(sessions.has("s2")).toBe(true);
  });

  test("awaiting_input session between DONE_EXPIRY_MS and MAX_STALE_MS is not pruned", () => {
    processHookEvent({ session_id: "s1", hook_event_name: "Stop" });
    expect(getHookState("s1")?.status).toBe("awaiting_input");

    const sessions = getAllHookSessions();
    const entry = sessions.get("s1");
    if (entry) {
      // Past DONE_EXPIRY_MS but within MAX_STALE_MS — should survive
      // because done-expiry only applies to "done" status
      entry.lastEventTime = Date.now() - DONE_EXPIRY_MS - 1;
    }

    pruneExpiredSessions();
    expect(sessions.has("s1")).toBe(true);
  });

  test("stale working session beyond MAX_STALE_MS is pruned from the map", () => {
    processHookEvent({ session_id: "s1", hook_event_name: "UserPromptSubmit" });

    const sessions = getAllHookSessions();
    const entry = sessions.get("s1");
    if (entry) {
      entry.lastEventTime = Date.now() - MAX_STALE_MS - 1;
    }

    pruneExpiredSessions();
    // Both the map entry and getHookState should be gone
    expect(sessions.has("s1")).toBe(false);
    expect(getHookState("s1")).toBeUndefined();
  });
});
