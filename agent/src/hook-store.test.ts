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

describe("hook-store constants", () => {
  test("DONE_EXPIRY_MS is 10 minutes", () => {
    expect(DONE_EXPIRY_MS).toBe(10 * 60 * 1000);
  });
});

describe("hook-store", () => {
  beforeEach(() => {
    clearHookSessions();
  });

  test("returns undefined for unknown session", () => {
    expect(getHookState("nonexistent")).toBeUndefined();
  });

  test("SessionStart sets awaiting_input", () => {
    processHookEvent({ session_id: "s1", hook_event_name: "SessionStart" });
    const state = getHookState("s1");
    expect(state?.status).toBe("awaiting_input");
    expect(state?.lastEvent).toBe("awaiting_input");
  });

  test("UserPromptSubmit sets working", () => {
    processHookEvent({ session_id: "s1", hook_event_name: "UserPromptSubmit" });
    expect(getHookState("s1")?.status).toBe("working");
  });

  test("PreToolUse sets working with tool name", () => {
    processHookEvent({
      session_id: "s1",
      hook_event_name: "PreToolUse",
      tool_name: "Bash",
    });
    const state = getHookState("s1");
    expect(state?.status).toBe("working");
    expect(state?.currentTool).toBe("Bash");
  });

  test("PostToolUse clears tool but stays working", () => {
    processHookEvent({
      session_id: "s1",
      hook_event_name: "PreToolUse",
      tool_name: "Bash",
    });
    processHookEvent({
      session_id: "s1",
      hook_event_name: "PostToolUse",
      tool_name: "Bash",
    });
    const state = getHookState("s1");
    expect(state?.status).toBe("working");
    expect(state?.currentTool).toBeUndefined();
  });

  test("Stop after working reports working during grace period", () => {
    processHookEvent({ session_id: "s1", hook_event_name: "UserPromptSubmit" });
    processHookEvent({ session_id: "s1", hook_event_name: "Stop" });
    // Within the 5s grace period, should still report "working"
    expect(getHookState("s1")?.status).toBe("working");
  });

  test("Stop after working reports awaiting_input after grace period", () => {
    processHookEvent({ session_id: "s1", hook_event_name: "UserPromptSubmit" });
    processHookEvent({ session_id: "s1", hook_event_name: "Stop" });

    // Simulate grace period expiring by backdating lastWorkingTime
    const sessions = getAllHookSessions();
    const entry = sessions.get("s1");
    if (entry) {
      entry.lastWorkingTime = Date.now() - 10_000; // 10s ago, past 5s grace
    }

    expect(getHookState("s1")?.status).toBe("awaiting_input");
  });

  test("Stop without prior working sets awaiting_input immediately", () => {
    processHookEvent({ session_id: "s1", hook_event_name: "SessionStart" });
    processHookEvent({ session_id: "s1", hook_event_name: "Stop" });
    // No prior "working" → no grace period → immediate awaiting_input
    expect(getHookState("s1")?.status).toBe("awaiting_input");
  });

  test("Notification:permission_prompt sets action_required", () => {
    processHookEvent({
      session_id: "s1",
      hook_event_name: "Notification",
      notification_type: "permission_prompt",
    });
    expect(getHookState("s1")?.status).toBe("action_required");
  });

  test("SessionEnd sets done", () => {
    processHookEvent({ session_id: "s1", hook_event_name: "SessionEnd" });
    expect(getHookState("s1")?.status).toBe("done");
  });

  test("full lifecycle: start → prompt → tool → stop", () => {
    processHookEvent({ session_id: "s1", hook_event_name: "SessionStart" });
    expect(getHookState("s1")?.status).toBe("awaiting_input");

    processHookEvent({ session_id: "s1", hook_event_name: "UserPromptSubmit" });
    expect(getHookState("s1")?.status).toBe("working");

    processHookEvent({
      session_id: "s1",
      hook_event_name: "PreToolUse",
      tool_name: "Edit",
    });
    expect(getHookState("s1")?.status).toBe("working");
    expect(getHookState("s1")?.currentTool).toBe("Edit");

    processHookEvent({
      session_id: "s1",
      hook_event_name: "PostToolUse",
      tool_name: "Edit",
    });
    expect(getHookState("s1")?.status).toBe("working");
    expect(getHookState("s1")?.currentTool).toBeUndefined();

    processHookEvent({ session_id: "s1", hook_event_name: "Stop" });
    // Within grace period after working → still "working"
    expect(getHookState("s1")?.status).toBe("working");
  });

  test("tracks multiple sessions independently", () => {
    processHookEvent({ session_id: "a", hook_event_name: "UserPromptSubmit" });
    // Session b: Stop without prior working → no grace period
    processHookEvent({ session_id: "b", hook_event_name: "SessionStart" });
    processHookEvent({ session_id: "b", hook_event_name: "Stop" });
    expect(getHookState("a")?.status).toBe("working");
    expect(getHookState("b")?.status).toBe("awaiting_input");
  });

  test("stale working sessions return undefined after 5 minutes", () => {
    processHookEvent({ session_id: "s1", hook_event_name: "UserPromptSubmit" });
    expect(getHookState("s1")?.status).toBe("working");

    const sessions = getAllHookSessions();
    const entry = sessions.get("s1");
    if (entry) {
      entry.lastEventTime = Date.now() - 6 * 60 * 1000; // 6 minutes ago
    }

    expect(getHookState("s1")).toBeUndefined();
  });

  test("working sessions within 5 minutes are not stale", () => {
    processHookEvent({ session_id: "s1", hook_event_name: "UserPromptSubmit" });

    const sessions = getAllHookSessions();
    const entry = sessions.get("s1");
    if (entry) {
      entry.lastEventTime = Date.now() - 3 * 60 * 1000; // 3 minutes ago
    }

    expect(getHookState("s1")?.status).toBe("working");
  });

  test("stale awaiting_input sessions still return state", () => {
    processHookEvent({ session_id: "s1", hook_event_name: "Stop" });
    expect(getHookState("s1")?.status).toBe("awaiting_input");

    const sessions = getAllHookSessions();
    const entry = sessions.get("s1");
    if (entry) {
      entry.lastEventTime = Date.now() - 120_000;
    }

    const state = getHookState("s1");
    expect(state).toBeDefined();
    expect(state?.status).toBe("awaiting_input");
  });

  test("stale done sessions still return state", () => {
    processHookEvent({ session_id: "s1", hook_event_name: "SessionEnd" });
    expect(getHookState("s1")?.status).toBe("done");

    const sessions = getAllHookSessions();
    const entry = sessions.get("s1");
    if (entry) {
      entry.lastEventTime = Date.now() - 120_000;
    }

    const state = getHookState("s1");
    expect(state).toBeDefined();
    expect(state?.status).toBe("done");
  });

  test("stale action_required sessions still return state", () => {
    processHookEvent({
      session_id: "s1",
      hook_event_name: "Notification",
      notification_type: "permission_prompt",
    });
    expect(getHookState("s1")?.status).toBe("action_required");

    const sessions = getAllHookSessions();
    const entry = sessions.get("s1");
    if (entry) {
      entry.lastEventTime = Date.now() - 120_000;
    }

    const state = getHookState("s1");
    expect(state).toBeDefined();
    expect(state?.status).toBe("action_required");
  });

  test("ignores events without session_id", () => {
    processHookEvent({ session_id: "", hook_event_name: "Stop" });
    expect(getHookState("")).toBeUndefined();
  });

  test("PostToolUseFailure keeps working status", () => {
    processHookEvent({ session_id: "s1", hook_event_name: "UserPromptSubmit" });
    processHookEvent({
      session_id: "s1",
      hook_event_name: "PostToolUseFailure",
      tool_name: "Bash",
    });
    expect(getHookState("s1")?.status).toBe("working");
  });
});

describe("pruneExpiredSessions", () => {
  beforeEach(() => {
    clearHookSessions();
  });

  test("removes done sessions older than DONE_EXPIRY_MS", () => {
    processHookEvent({ session_id: "s1", hook_event_name: "SessionEnd" });
    expect(getHookState("s1")?.status).toBe("done");

    // Simulate time passing beyond expiry
    const sessions = getAllHookSessions();
    const entry = sessions.get("s1");
    if (entry) {
      entry.lastEventTime = Date.now() - DONE_EXPIRY_MS - 1;
    }

    pruneExpiredSessions();
    expect(sessions.has("s1")).toBe(false);
  });

  test("preserves done sessions younger than DONE_EXPIRY_MS", () => {
    processHookEvent({ session_id: "s1", hook_event_name: "SessionEnd" });
    expect(getHookState("s1")?.status).toBe("done");

    // Session is recent — should not be pruned
    pruneExpiredSessions();
    const sessions = getAllHookSessions();
    expect(sessions.has("s1")).toBe(true);
  });

  test("removes any session older than MAX_STALE_MS regardless of status", () => {
    processHookEvent({ session_id: "s1", hook_event_name: "Stop" });
    expect(getHookState("s1")?.status).toBe("awaiting_input");

    const sessions = getAllHookSessions();
    const entry = sessions.get("s1");
    if (entry) {
      entry.lastEventTime = Date.now() - MAX_STALE_MS - 1;
    }

    pruneExpiredSessions();
    expect(sessions.has("s1")).toBe(false);
  });

  test("preserves recent working sessions", () => {
    processHookEvent({ session_id: "s1", hook_event_name: "UserPromptSubmit" });
    expect(getHookState("s1")?.status).toBe("working");

    pruneExpiredSessions();
    const sessions = getAllHookSessions();
    expect(sessions.has("s1")).toBe(true);
  });

  test("preserves awaiting_input sessions within MAX_STALE_MS", () => {
    processHookEvent({ session_id: "s1", hook_event_name: "Stop" });
    expect(getHookState("s1")?.status).toBe("awaiting_input");

    pruneExpiredSessions();
    const sessions = getAllHookSessions();
    expect(sessions.has("s1")).toBe(true);
  });

  test("prunes stale action_required sessions beyond MAX_STALE_MS", () => {
    processHookEvent({
      session_id: "s1",
      hook_event_name: "Notification",
      notification_type: "permission_prompt",
    });
    expect(getHookState("s1")?.status).toBe("action_required");

    const sessions = getAllHookSessions();
    const entry = sessions.get("s1");
    if (entry) {
      entry.lastEventTime = Date.now() - MAX_STALE_MS - 1;
    }

    pruneExpiredSessions();
    expect(sessions.has("s1")).toBe(false);
  });

  test("clearHookSessions still clears all sessions", () => {
    processHookEvent({ session_id: "s1", hook_event_name: "UserPromptSubmit" });
    processHookEvent({ session_id: "s2", hook_event_name: "SessionEnd" });
    processHookEvent({ session_id: "s3", hook_event_name: "Stop" });

    const sessions = getAllHookSessions();
    expect(sessions.size).toBe(3);

    clearHookSessions();
    expect(sessions.size).toBe(0);
  });

  test("prunes only expired sessions from a mix of fresh and stale", () => {
    // Fresh working session
    processHookEvent({ session_id: "fresh", hook_event_name: "UserPromptSubmit" });
    // Old done session
    processHookEvent({ session_id: "old-done", hook_event_name: "SessionEnd" });
    // Old awaiting_input session
    processHookEvent({ session_id: "old-await", hook_event_name: "Stop" });

    const sessions = getAllHookSessions();
    const oldDone = sessions.get("old-done");
    if (oldDone) {
      oldDone.lastEventTime = Date.now() - DONE_EXPIRY_MS - 1;
    }
    const oldAwait = sessions.get("old-await");
    if (oldAwait) {
      oldAwait.lastEventTime = Date.now() - MAX_STALE_MS - 1;
    }

    pruneExpiredSessions();
    expect(sessions.has("fresh")).toBe(true);
    expect(sessions.has("old-done")).toBe(false);
    expect(sessions.has("old-await")).toBe(false);
  });
});
