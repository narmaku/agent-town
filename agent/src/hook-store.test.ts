import { beforeEach, describe, expect, test } from "bun:test";
import { clearHookSessions, getAllHookSessions, getHookState, updateHookState } from "./hook-store";
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

  test("Stop sets awaiting_input", () => {
    processHookEvent({ session_id: "s1", hook_event_name: "UserPromptSubmit" });
    processHookEvent({ session_id: "s1", hook_event_name: "Stop" });
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
    expect(getHookState("s1")?.status).toBe("awaiting_input");
  });

  test("tracks multiple sessions independently", () => {
    processHookEvent({ session_id: "a", hook_event_name: "UserPromptSubmit" });
    processHookEvent({ session_id: "b", hook_event_name: "Stop" });
    expect(getHookState("a")?.status).toBe("working");
    expect(getHookState("b")?.status).toBe("awaiting_input");
  });

  test("stale working sessions return undefined", () => {
    processHookEvent({ session_id: "s1", hook_event_name: "UserPromptSubmit" });
    expect(getHookState("s1")?.status).toBe("working");

    const sessions = getAllHookSessions();
    const entry = sessions.get("s1");
    if (entry) {
      entry.lastEventTime = Date.now() - 120_000; // 2 minutes ago
    }

    expect(getHookState("s1")).toBeUndefined();
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
