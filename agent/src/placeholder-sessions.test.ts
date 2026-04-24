import { beforeEach, describe, expect, test } from "bun:test";
import type { SessionInfo } from "@agent-town/shared";
import {
  createPlaceholderSessions,
  expirePlaceholders,
  resetPlaceholderTimestamps,
  setPlaceholderCreatedAt,
} from "./placeholder-sessions";
import type { ProcessMapping } from "./process-mapper";

function makeMapping(overrides: Partial<ProcessMapping> = {}): ProcessMapping {
  return {
    multiplexer: "zellij",
    session: "my-session",
    hasActiveChildren: true,
    agentType: "claude-code",
    ...overrides,
  };
}

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

describe("createPlaceholderSessions", () => {
  beforeEach(() => {
    resetPlaceholderTimestamps();
  });

  test("creates placeholder when no real session claims the mux session", () => {
    const sessions: SessionInfo[] = [];
    const mappings = new Map<string, ProcessMapping>();
    mappings.set("cwd:/home/user/project", makeMapping({ session: "agent-1" }));
    const activeMuxNames = new Set(["agent-1"]);

    createPlaceholderSessions(sessions, mappings, activeMuxNames);

    expect(sessions).toHaveLength(1);
    expect(sessions[0].sessionId).toBe("pending-agent-1");
    expect(sessions[0].status).toBe("starting");
    expect(sessions[0].multiplexerSession).toBe("agent-1");
  });

  test("does not create placeholder when real session already claims the mux session", () => {
    const sessions: SessionInfo[] = [makeSession({ multiplexerSession: "agent-1" })];
    const mappings = new Map<string, ProcessMapping>();
    mappings.set("cwd:/home/user/project", makeMapping({ session: "agent-1" }));
    const activeMuxNames = new Set(["agent-1"]);

    createPlaceholderSessions(sessions, mappings, activeMuxNames);

    // Should still have only the real session
    expect(sessions).toHaveLength(1);
    expect(sessions[0].sessionId).toBe("real-uuid-1234");
  });

  test("does not create placeholder when mux session is not active", () => {
    const sessions: SessionInfo[] = [];
    const mappings = new Map<string, ProcessMapping>();
    mappings.set("cwd:/home/user/project", makeMapping({ session: "dead-session" }));
    const activeMuxNames = new Set(["other-session"]);

    createPlaceholderSessions(sessions, mappings, activeMuxNames);

    expect(sessions).toHaveLength(0);
  });

  test("does not create placeholder for session-id-based keys without cwd", () => {
    const sessions: SessionInfo[] = [];
    const mappings = new Map<string, ProcessMapping>();
    mappings.set("session-id-key", makeMapping({ session: "agent-1" }));
    const activeMuxNames = new Set(["agent-1"]);

    createPlaceholderSessions(sessions, mappings, activeMuxNames);

    expect(sessions).toHaveLength(0);
  });

  test("creates multiple placeholders for different mux sessions", () => {
    const sessions: SessionInfo[] = [];
    const mappings = new Map<string, ProcessMapping>();
    mappings.set("cwd:/project-a", makeMapping({ session: "agent-1" }));
    mappings.set("cwd:/project-b", makeMapping({ session: "agent-2" }));
    const activeMuxNames = new Set(["agent-1", "agent-2"]);

    createPlaceholderSessions(sessions, mappings, activeMuxNames);

    expect(sessions).toHaveLength(2);
    const ids = sessions.map((s) => s.sessionId).sort();
    expect(ids).toEqual(["pending-agent-1", "pending-agent-2"]);
  });
});

describe("expirePlaceholders", () => {
  beforeEach(() => {
    resetPlaceholderTimestamps();
  });

  test("keeps fresh placeholders", () => {
    // Create a placeholder to register its timestamp
    const sessions: SessionInfo[] = [];
    const mappings = new Map<string, ProcessMapping>();
    mappings.set("cwd:/project", makeMapping({ session: "fresh-agent" }));
    const activeMuxNames = new Set(["fresh-agent"]);

    createPlaceholderSessions(sessions, mappings, activeMuxNames);
    expect(sessions).toHaveLength(1);

    // Expire should keep it since it was just created
    const result = expirePlaceholders(sessions);
    expect(result).toHaveLength(1);
    expect(result[0].sessionId).toBe("pending-fresh-agent");
  });

  test("removes placeholders older than TTL", () => {
    // Create placeholder with a timestamp in the past
    const sessions: SessionInfo[] = [];
    const mappings = new Map<string, ProcessMapping>();
    mappings.set("cwd:/project", makeMapping({ session: "old-agent" }));
    const activeMuxNames = new Set(["old-agent"]);

    createPlaceholderSessions(sessions, mappings, activeMuxNames);
    expect(sessions).toHaveLength(1);

    // Manually set the creation time to 4 minutes ago (past the 3 min TTL)
    setPlaceholderCreatedAt("pending-old-agent", Date.now() - 4 * 60 * 1000);

    const result = expirePlaceholders(sessions);
    expect(result).toHaveLength(0);
  });

  test("keeps non-placeholder sessions regardless of age", () => {
    const sessions: SessionInfo[] = [makeSession({ sessionId: "real-session-123" })];

    const result = expirePlaceholders(sessions);
    expect(result).toHaveLength(1);
    expect(result[0].sessionId).toBe("real-session-123");
  });

  test("keeps fresh placeholder but removes expired one", () => {
    const sessions: SessionInfo[] = [];
    const mappings = new Map<string, ProcessMapping>();
    mappings.set("cwd:/project-a", makeMapping({ session: "fresh" }));
    mappings.set("cwd:/project-b", makeMapping({ session: "expired" }));
    const activeMuxNames = new Set(["fresh", "expired"]);

    createPlaceholderSessions(sessions, mappings, activeMuxNames);
    expect(sessions).toHaveLength(2);

    // Age the "expired" placeholder past TTL
    setPlaceholderCreatedAt("pending-expired", Date.now() - 4 * 60 * 1000);

    const result = expirePlaceholders(sessions);
    expect(result).toHaveLength(1);
    expect(result[0].sessionId).toBe("pending-fresh");
  });
});

describe("agent-side deduplication", () => {
  beforeEach(() => {
    resetPlaceholderTimestamps();
  });

  test("real session and placeholder with same mux session: only real is kept after dedup", () => {
    // Simulate the scenario: a real session was discovered, then a placeholder
    // was also created for the same mux session (race condition).
    // We test the dedup logic that would run in index.ts
    const realSession = makeSession({
      sessionId: "uuid-real",
      multiplexerSession: "my-mux",
    });

    const placeholderSession = makeSession({
      sessionId: "pending-my-mux",
      status: "starting",
      multiplexerSession: "my-mux",
    });

    const sessions = [realSession, placeholderSession];

    // Dedup: build set of mux sessions claimed by real (non-pending) sessions,
    // then filter out placeholders whose mux session is already claimed
    const realMuxSessions = new Set(
      sessions
        .filter((s) => !s.sessionId.startsWith("pending-"))
        .filter((s) => s.multiplexerSession)
        .map((s) => s.multiplexerSession),
    );

    const deduped = sessions.filter((s) => {
      if (s.sessionId.startsWith("pending-") && s.multiplexerSession && realMuxSessions.has(s.multiplexerSession)) {
        return false;
      }
      return true;
    });

    expect(deduped).toHaveLength(1);
    expect(deduped[0].sessionId).toBe("uuid-real");
  });

  test("placeholder without a conflicting real session is preserved", () => {
    const placeholderSession = makeSession({
      sessionId: "pending-solo-mux",
      status: "starting",
      multiplexerSession: "solo-mux",
    });

    const sessions = [placeholderSession];

    const realMuxSessions = new Set(
      sessions
        .filter((s) => !s.sessionId.startsWith("pending-"))
        .filter((s) => s.multiplexerSession)
        .map((s) => s.multiplexerSession),
    );

    const deduped = sessions.filter((s) => {
      if (s.sessionId.startsWith("pending-") && s.multiplexerSession && realMuxSessions.has(s.multiplexerSession)) {
        return false;
      }
      return true;
    });

    expect(deduped).toHaveLength(1);
    expect(deduped[0].sessionId).toBe("pending-solo-mux");
  });

  test("multiple different mux sessions handled correctly - no false dedup", () => {
    const real1 = makeSession({
      sessionId: "uuid-1",
      multiplexerSession: "mux-a",
    });
    const placeholder1 = makeSession({
      sessionId: "pending-mux-b",
      status: "starting",
      multiplexerSession: "mux-b",
    });
    const placeholder2 = makeSession({
      sessionId: "pending-mux-c",
      status: "starting",
      multiplexerSession: "mux-c",
    });

    const sessions = [real1, placeholder1, placeholder2];

    const realMuxSessions = new Set(
      sessions
        .filter((s) => !s.sessionId.startsWith("pending-"))
        .filter((s) => s.multiplexerSession)
        .map((s) => s.multiplexerSession),
    );

    const deduped = sessions.filter((s) => {
      if (s.sessionId.startsWith("pending-") && s.multiplexerSession && realMuxSessions.has(s.multiplexerSession)) {
        return false;
      }
      return true;
    });

    // real1 for mux-a, placeholder for mux-b, placeholder for mux-c — all kept
    expect(deduped).toHaveLength(3);
  });
});
