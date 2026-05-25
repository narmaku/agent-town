import { describe, expect, test } from "bun:test";
import type { MultiplexerSessionInfo, SessionInfo } from "@agent-town/shared";
import type { ProcessMapping } from "./process-mapper";
import { discoverAndMapSessions } from "./session-mapping";

function makeSession(overrides: Partial<SessionInfo> = {}): SessionInfo {
  return {
    sessionId: "real-uuid-1234",
    agentType: "claude-code",
    slug: "test",
    projectPath: "/home/user/project",
    projectName: "project",
    gitBranch: "main",
    status: "working",
    lastActivity: new Date().toISOString(),
    lastMessage: "Working...",
    cwd: "/home/user/project",
    ...overrides,
  };
}

function makeMapping(overrides: Partial<ProcessMapping> = {}): ProcessMapping {
  return {
    multiplexer: "zellij",
    session: "my-session",
    hasActiveChildren: true,
    agentType: "claude-code",
    ...overrides,
  };
}

function makeMuxSession(name: string, multiplexer: "zellij" | "tmux" = "zellij"): MultiplexerSessionInfo {
  return { name, multiplexer, attached: true };
}

describe("discoverAndMapSessions", () => {
  test("maps session by sessionId when key matches", () => {
    const sessions = [makeSession({ sessionId: "uuid-1" })];
    const muxSessions = [makeMuxSession("agent-1")];
    const mappings = new Map<string, ProcessMapping>();
    mappings.set("uuid-1", makeMapping({ session: "agent-1" }));

    discoverAndMapSessions(sessions, muxSessions, mappings);

    expect(sessions[0].multiplexerSession).toBe("agent-1");
    expect(sessions[0].multiplexer).toBe("zellij");
  });

  test("rejects mapping when mux session is not active", () => {
    const sessions = [makeSession({ sessionId: "uuid-1" })];
    const muxSessions = [makeMuxSession("other-session")];
    const mappings = new Map<string, ProcessMapping>();
    mappings.set("uuid-1", makeMapping({ session: "dead-session" }));

    discoverAndMapSessions(sessions, muxSessions, mappings);

    expect(sessions[0].multiplexerSession).toBeUndefined();
  });

  test("falls back to CWD matching when sessionId key not found", () => {
    const sessions = [makeSession({ sessionId: "uuid-1", cwd: "/root/dev/freqtrade" })];
    const muxSessions = [makeMuxSession("strategies")];
    const mappings = new Map<string, ProcessMapping>();
    mappings.set("cwd:/root/dev/freqtrade", makeMapping({ session: "strategies" }));

    discoverAndMapSessions(sessions, muxSessions, mappings);

    expect(sessions[0].multiplexerSession).toBe("strategies");
    expect(sessions[0].multiplexer).toBe("zellij");
  });

  test("CWD fallback does not override sessionId match", () => {
    const sessions = [makeSession({ sessionId: "uuid-1", cwd: "/root/dev/freqtrade" })];
    const muxSessions = [makeMuxSession("agent-1"), makeMuxSession("strategies")];
    const mappings = new Map<string, ProcessMapping>();
    mappings.set("uuid-1", makeMapping({ session: "agent-1" }));
    mappings.set("cwd:/root/dev/freqtrade", makeMapping({ session: "strategies" }));

    discoverAndMapSessions(sessions, muxSessions, mappings);

    expect(sessions[0].multiplexerSession).toBe("agent-1");
  });

  test("CWD fallback skips if mux session already claimed by another session", () => {
    const sessions = [
      makeSession({ sessionId: "uuid-1", cwd: "/root/dev/freqtrade", multiplexerSession: undefined }),
      makeSession({ sessionId: "uuid-2", cwd: "/root/dev/freqtrade", multiplexerSession: undefined }),
    ];
    const muxSessions = [makeMuxSession("strategies")];
    const mappings = new Map<string, ProcessMapping>();
    mappings.set("cwd:/root/dev/freqtrade", makeMapping({ session: "strategies" }));

    discoverAndMapSessions(sessions, muxSessions, mappings);

    const mapped = sessions.filter((s) => s.multiplexerSession === "strategies");
    expect(mapped).toHaveLength(1);
  });

  test("CWD fallback skips session without cwd", () => {
    const sessions = [makeSession({ sessionId: "uuid-1", cwd: undefined })];
    const muxSessions = [makeMuxSession("strategies")];
    const mappings = new Map<string, ProcessMapping>();
    mappings.set("cwd:/root/dev/freqtrade", makeMapping({ session: "strategies" }));

    discoverAndMapSessions(sessions, muxSessions, mappings);

    expect(sessions[0].multiplexerSession).toBeUndefined();
  });

  test("CWD fallback prevents placeholder creation for the same mux session", () => {
    const sessions = [makeSession({ sessionId: "uuid-1", cwd: "/root/dev/freqtrade" })];
    const muxSessions = [makeMuxSession("strategies")];
    const mappings = new Map<string, ProcessMapping>();
    mappings.set("cwd:/root/dev/freqtrade", makeMapping({ session: "strategies" }));

    discoverAndMapSessions(sessions, muxSessions, mappings);

    expect(sessions[0].multiplexerSession).toBe("strategies");

    // After CWD fallback maps the session, placeholder creation should
    // see the mux session is already claimed and skip it
    const { createPlaceholderSessions } = require("./placeholder-sessions");
    createPlaceholderSessions(sessions, mappings, new Set(["strategies"]));

    expect(sessions).toHaveLength(1);
    expect(sessions[0].sessionId).toBe("uuid-1");
  });

  test("returns active mux names set", () => {
    const sessions: SessionInfo[] = [];
    const muxSessions = [makeMuxSession("a"), makeMuxSession("b")];

    const result = discoverAndMapSessions(sessions, muxSessions, new Map());

    expect(result).toEqual(new Set(["a", "b"]));
  });

  test("sessionId match claims mux session preventing CWD fallback for others", () => {
    const sessions = [
      makeSession({ sessionId: "uuid-1", cwd: "/root/dev/freqtrade" }),
      makeSession({ sessionId: "uuid-2", cwd: "/root/dev/freqtrade" }),
    ];
    const muxSessions = [makeMuxSession("strategies")];
    const mappings = new Map<string, ProcessMapping>();
    mappings.set("uuid-1", makeMapping({ session: "strategies" }));
    mappings.set("cwd:/root/dev/freqtrade", makeMapping({ session: "strategies" }));

    discoverAndMapSessions(sessions, muxSessions, mappings);

    expect(sessions[0].multiplexerSession).toBe("strategies");
    expect(sessions[1].multiplexerSession).toBeUndefined();
  });
});
