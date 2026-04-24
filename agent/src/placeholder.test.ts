import { describe, expect, test } from "bun:test";

import type { SessionInfo } from "@agent-town/shared";

import { createPlaceholderSessions } from "./placeholder-sessions";
import type { ProcessMapping } from "./process-mapper";

function makeMapping(overrides: Partial<ProcessMapping> = {}): ProcessMapping {
  return {
    multiplexer: "zellij",
    session: "test-session",
    hasActiveChildren: false,
    ...overrides,
  };
}

describe("createPlaceholderSessions", () => {
  test("placeholder sessions have status 'starting'", () => {
    const sessions: SessionInfo[] = [];
    const processMappings = new Map<string, ProcessMapping>();
    processMappings.set("cwd:/home/user/project", makeMapping({ session: "my-agent" }));
    const activeMuxNames = new Set(["my-agent"]);

    createPlaceholderSessions(sessions, processMappings, activeMuxNames);

    expect(sessions).toHaveLength(1);
    expect(sessions[0].status).toBe("starting");
  });

  test("placeholder sessions include agentType from mapping", () => {
    const sessions: SessionInfo[] = [];
    const processMappings = new Map<string, ProcessMapping>();
    processMappings.set("cwd:/home/user/project", makeMapping({ session: "my-agent", agentType: "claude-code" }));
    const activeMuxNames = new Set(["my-agent"]);

    createPlaceholderSessions(sessions, processMappings, activeMuxNames);

    expect(sessions).toHaveLength(1);
    expect(sessions[0].agentType).toBe("claude-code");
  });

  test("placeholder sessions have correct lastMessage for starting status", () => {
    const sessions: SessionInfo[] = [];
    const processMappings = new Map<string, ProcessMapping>();
    processMappings.set("cwd:/home/user/project", makeMapping({ session: "my-agent" }));
    const activeMuxNames = new Set(["my-agent"]);

    createPlaceholderSessions(sessions, processMappings, activeMuxNames);

    expect(sessions).toHaveLength(1);
    expect(sessions[0].lastMessage).toBe("Starting up\u2026");
  });

  test("placeholder sessions use correct sessionId format", () => {
    const sessions: SessionInfo[] = [];
    const processMappings = new Map<string, ProcessMapping>();
    processMappings.set("cwd:/home/user/project", makeMapping({ session: "my-agent" }));
    const activeMuxNames = new Set(["my-agent"]);

    createPlaceholderSessions(sessions, processMappings, activeMuxNames);

    expect(sessions[0].sessionId).toBe("pending-my-agent");
  });

  test("skips mappings whose mux session is already mapped to a real session", () => {
    const sessions: SessionInfo[] = [
      {
        sessionId: "real-session",
        agentType: "claude-code",
        slug: "my-agent",
        projectPath: "/home/user/project",
        projectName: "project",
        gitBranch: "main",
        status: "working",
        lastActivity: new Date().toISOString(),
        lastMessage: "Working on something",
        cwd: "/home/user/project",
        multiplexerSession: "my-agent",
        multiplexer: "zellij",
      },
    ];
    const processMappings = new Map<string, ProcessMapping>();
    processMappings.set("cwd:/home/user/project", makeMapping({ session: "my-agent" }));
    const activeMuxNames = new Set(["my-agent"]);

    createPlaceholderSessions(sessions, processMappings, activeMuxNames);

    // Should not add a placeholder since "my-agent" mux session is already claimed
    expect(sessions).toHaveLength(1);
    expect(sessions[0].sessionId).toBe("real-session");
  });

  test("skips mappings whose mux session does not exist in active list", () => {
    const sessions: SessionInfo[] = [];
    const processMappings = new Map<string, ProcessMapping>();
    processMappings.set("cwd:/home/user/project", makeMapping({ session: "ghost-session" }));
    const activeMuxNames = new Set(["other-session"]);

    createPlaceholderSessions(sessions, processMappings, activeMuxNames);

    expect(sessions).toHaveLength(0);
  });

  test("skips sessionId-based keys (non-cwd keys)", () => {
    const sessions: SessionInfo[] = [];
    const processMappings = new Map<string, ProcessMapping>();
    // This key is a session ID, not a cwd: prefix
    processMappings.set("some-session-id", makeMapping({ session: "my-agent" }));
    const activeMuxNames = new Set(["my-agent"]);

    createPlaceholderSessions(sessions, processMappings, activeMuxNames);

    expect(sessions).toHaveLength(0);
  });

  test("placeholder agentType defaults to claude-code when not set in mapping", () => {
    const sessions: SessionInfo[] = [];
    const processMappings = new Map<string, ProcessMapping>();
    processMappings.set("cwd:/home/user/project", makeMapping({ session: "my-agent" }));
    const activeMuxNames = new Set(["my-agent"]);

    createPlaceholderSessions(sessions, processMappings, activeMuxNames);

    expect(sessions).toHaveLength(1);
    expect(sessions[0].agentType).toBe("claude-code");
  });

  test("skips placeholder when a real session with the same CWD already exists", () => {
    // This handles the duplication bug: user delays before first message,
    // so the JSONL session exists but hasn't been mapped to a multiplexer
    // session yet (birth-time matching failed). Without this check, both
    // the real session and a placeholder would appear in the dashboard.
    const sessions: SessionInfo[] = [
      {
        sessionId: "550e8400-e29b-41d4-a716-446655440000",
        agentType: "claude-code",
        slug: "test",
        projectPath: "/home/user/project",
        projectName: "project",
        gitBranch: "main",
        status: "working",
        lastActivity: new Date().toISOString(),
        lastMessage: "Working",
        cwd: "/home/user/project",
        // Note: no multiplexerSession — mapping failed
      },
    ];
    const processMappings = new Map<string, ProcessMapping>();
    processMappings.set("cwd:/home/user/project", makeMapping({ session: "my-agent" }));
    const activeMuxNames = new Set(["my-agent"]);

    createPlaceholderSessions(sessions, processMappings, activeMuxNames);

    // Should NOT create a placeholder because a real session shares the CWD
    expect(sessions).toHaveLength(1);
    expect(sessions[0].sessionId).toBe("550e8400-e29b-41d4-a716-446655440000");
  });

  test("still creates placeholder when no real session shares the CWD", () => {
    // Truly new session: no JSONL at all, only a running process
    const sessions: SessionInfo[] = [];
    const processMappings = new Map<string, ProcessMapping>();
    processMappings.set("cwd:/home/user/project", makeMapping({ session: "brand-new" }));
    const activeMuxNames = new Set(["brand-new"]);

    createPlaceholderSessions(sessions, processMappings, activeMuxNames);

    expect(sessions).toHaveLength(1);
    expect(sessions[0].sessionId).toBe("pending-brand-new");
  });

  test("does not skip placeholder based on another pending session CWD", () => {
    // Only real (non-pending) sessions should suppress placeholder creation
    const sessions: SessionInfo[] = [
      {
        sessionId: "pending-other-session",
        agentType: "claude-code",
        slug: "other",
        projectPath: "/home/user/project",
        projectName: "project",
        gitBranch: "",
        status: "starting",
        lastActivity: new Date().toISOString(),
        lastMessage: "Starting...",
        cwd: "/home/user/project",
        multiplexerSession: "other-session",
        multiplexer: "zellij",
      },
    ];
    const processMappings = new Map<string, ProcessMapping>();
    processMappings.set("cwd:/home/user/project", makeMapping({ session: "new-agent" }));
    const activeMuxNames = new Set(["new-agent", "other-session"]);

    createPlaceholderSessions(sessions, processMappings, activeMuxNames);

    // Should still create placeholder — the existing session is a pending-* too
    expect(sessions).toHaveLength(2);
    expect(sessions[1].sessionId).toBe("pending-new-agent");
  });
});
