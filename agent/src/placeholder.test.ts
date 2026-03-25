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
});
