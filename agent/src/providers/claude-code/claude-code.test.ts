import { describe, expect, test } from "bun:test";
import { handleClaudeHookEvent } from "./hook-handler";
import { ClaudeCodeProvider } from "./index";

describe("ClaudeCodeProvider", () => {
  const provider = new ClaudeCodeProvider();

  test("has correct type and display name", () => {
    expect(provider.type).toBe("claude-code");
    expect(provider.displayName).toBe("Claude Code");
    expect(provider.binaryName).toBe("claude");
  });

  test("buildLaunchCommand with defaults", () => {
    const cmd = provider.buildLaunchCommand({});
    expect(cmd).toBe("claude");
  });

  test("buildLaunchCommand with model", () => {
    const cmd = provider.buildLaunchCommand({ model: "claude-opus-4-6" });
    expect(cmd).toBe("claude --model claude-opus-4-6");
  });

  test("buildLaunchCommand with autonomous", () => {
    const cmd = provider.buildLaunchCommand({ autonomous: true });
    expect(cmd).toBe("claude --dangerously-skip-permissions");
  });

  test("buildLaunchCommand with model and autonomous", () => {
    const cmd = provider.buildLaunchCommand({ model: "claude-opus-4-6", autonomous: true });
    expect(cmd).toBe("claude --model claude-opus-4-6 --dangerously-skip-permissions");
  });

  test("buildResumeCommand with session ID", () => {
    const cmd = provider.buildResumeCommand({ sessionId: "abc-123-def" });
    expect(cmd).toBe("claude --resume abc-123-def");
  });

  test("buildResumeCommand with model and autonomous", () => {
    const cmd = provider.buildResumeCommand({
      sessionId: "abc-123-def",
      model: "claude-opus-4-6",
      autonomous: true,
    });
    expect(cmd).toBe("claude --resume abc-123-def --model claude-opus-4-6 --dangerously-skip-permissions");
  });

  test("filterAgentProcesses filters only claude binaries", () => {
    const processes = [
      { pid: 1, ppid: 0, etimes: 100, args: "/usr/bin/claude --resume abc" },
      { pid: 2, ppid: 0, etimes: 200, args: "opencode --session xyz" },
      { pid: 3, ppid: 0, etimes: 50, args: "claude" },
      { pid: 4, ppid: 0, etimes: 300, args: "/home/user/.local/bin/node" },
    ];
    const result = provider.filterAgentProcesses(processes);
    expect(result).toHaveLength(2);
    expect(result[0].pid).toBe(1);
    expect(result[1].pid).toBe(3);
  });

  test("extractSessionIdFromArgs extracts UUID from --resume", () => {
    expect(provider.extractSessionIdFromArgs("claude --resume 550e8400-e29b-41d4-a716-446655440000")).toBe(
      "550e8400-e29b-41d4-a716-446655440000",
    );
  });

  test("extractSessionIdFromArgs returns undefined without --resume", () => {
    expect(provider.extractSessionIdFromArgs("claude")).toBeUndefined();
  });
});

describe("handleClaudeHookEvent", () => {
  test("returns null for non-Claude payloads", () => {
    expect(handleClaudeHookEvent(null)).toBeNull();
    expect(handleClaudeHookEvent({})).toBeNull();
    expect(handleClaudeHookEvent({ event_type: "session.idle", agent_type: "opencode" })).toBeNull();
  });

  test("handles UserPromptSubmit", () => {
    const result = handleClaudeHookEvent({ session_id: "s1", hook_event_name: "UserPromptSubmit" });
    expect(result).toEqual({ sessionId: "s1", status: "working", currentTool: undefined });
  });

  test("handles PreToolUse with tool name", () => {
    const result = handleClaudeHookEvent({ session_id: "s1", hook_event_name: "PreToolUse", tool_name: "Bash" });
    expect(result).toEqual({ sessionId: "s1", status: "working", currentTool: "Bash" });
  });

  test("handles Stop", () => {
    const result = handleClaudeHookEvent({ session_id: "s1", hook_event_name: "Stop" });
    expect(result).toEqual({ sessionId: "s1", status: "awaiting_input", currentTool: undefined });
  });

  test("handles SessionEnd", () => {
    const result = handleClaudeHookEvent({ session_id: "s1", hook_event_name: "SessionEnd" });
    expect(result).toEqual({ sessionId: "s1", status: "done", currentTool: undefined });
  });

  test("handles Notification:permission_prompt", () => {
    const result = handleClaudeHookEvent({
      session_id: "s1",
      hook_event_name: "Notification",
      notification_type: "permission_prompt",
    });
    expect(result).toEqual({ sessionId: "s1", status: "action_required", currentTool: undefined });
  });

  test("returns null for empty session_id", () => {
    const result = handleClaudeHookEvent({ session_id: "", hook_event_name: "Stop" });
    expect(result).toBeNull();
  });
});
