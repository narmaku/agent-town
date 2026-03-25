import { describe, expect, mock, test } from "bun:test";
import { join } from "node:path";

import { handleClaudeHookEvent } from "./hook-handler";

// Mock process-mapper to control findSessionCandidates in matchProcessToSessionId tests
const PROCESS_MAPPER_PATH = join(import.meta.dir, "process-mapper.ts");

// Keep the real matchSessionByBirthTime and extractClaudeSessionIdFromArgs,
// only mock findSessionCandidates so we can control what candidates are returned.
const { extractClaudeSessionIdFromArgs: realExtract, matchSessionByBirthTime: realMatchByBirthTime } = await import(
  "./process-mapper"
);

let mockCandidates: { id: string; birthtimeMs: number }[] = [];

mock.module(PROCESS_MAPPER_PATH, () => ({
  extractClaudeSessionIdFromArgs: realExtract,
  matchSessionByBirthTime: realMatchByBirthTime,
  findSessionCandidates: async () => mockCandidates,
}));

// Import ClaudeCodeProvider AFTER mocking so it picks up our mock
const { ClaudeCodeProvider } = await import("./index");

describe("ClaudeCodeProvider", () => {
  const provider = new ClaudeCodeProvider();

  test("has correct type and display name", () => {
    expect(provider.type).toBe("claude-code");
    expect(provider.displayName).toBe("Claude Code");
    expect(provider.binaryName).toBe("claude");
  });

  test("buildLaunchCommand with defaults returns array", () => {
    const parts = provider.buildLaunchCommand({});
    expect(parts).toEqual(["claude"]);
  });

  test("buildLaunchCommand with model returns array with flag and value", () => {
    const parts = provider.buildLaunchCommand({ model: "claude-opus-4-6" });
    expect(parts).toEqual(["claude", "--model", "claude-opus-4-6"]);
  });

  test("buildLaunchCommand with autonomous returns array with flag", () => {
    const parts = provider.buildLaunchCommand({ autonomous: true });
    expect(parts).toEqual(["claude", "--dangerously-skip-permissions"]);
  });

  test("buildLaunchCommand with model and autonomous", () => {
    const parts = provider.buildLaunchCommand({ model: "claude-opus-4-6", autonomous: true });
    expect(parts).toEqual(["claude", "--model", "claude-opus-4-6", "--dangerously-skip-permissions"]);
  });

  test("buildResumeCommand with session ID returns array", () => {
    const parts = provider.buildResumeCommand({ sessionId: "abc-123-def" });
    expect(parts).toEqual(["claude", "--resume", "abc-123-def"]);
  });

  test("buildResumeCommand with model and autonomous", () => {
    const parts = provider.buildResumeCommand({
      sessionId: "abc-123-def",
      model: "claude-opus-4-6",
      autonomous: true,
    });
    expect(parts).toEqual([
      "claude",
      "--resume",
      "abc-123-def",
      "--model",
      "claude-opus-4-6",
      "--dangerously-skip-permissions",
    ]);
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

  test("matchProcessToSessionId returns undefined when no birth time match exists (no kidnapping fallback)", async () => {
    const now = Date.now();
    // Candidate was created 1 hour ago — far outside the 2-minute match window
    // for a process that started 5 seconds ago
    mockCandidates = [{ id: "existing-session", birthtimeMs: now - 3_600_000 }];
    const processStartMs = now - 5_000;

    const result = await provider.matchProcessToSessionId("/some/project", processStartMs, new Set());
    // Must return undefined — NOT "existing-session" (which would be session kidnapping)
    expect(result).toBeUndefined();
  });

  test("matchProcessToSessionId returns undefined when all candidates are claimed", async () => {
    const now = Date.now();
    mockCandidates = [{ id: "claimed-session", birthtimeMs: now - 5_000 }];
    const processStartMs = now - 6_000;

    const result = await provider.matchProcessToSessionId(
      "/some/project",
      processStartMs,
      new Set(["claimed-session"]),
    );
    expect(result).toBeUndefined();
  });

  test("matchProcessToSessionId matches by birth time when within window", async () => {
    const now = Date.now();
    mockCandidates = [{ id: "matching-session", birthtimeMs: now - 5_000 }];
    const processStartMs = now - 6_000;

    const result = await provider.matchProcessToSessionId("/some/project", processStartMs, new Set());
    expect(result).toBe("matching-session");
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
