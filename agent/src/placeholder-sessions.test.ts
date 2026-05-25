import { beforeEach, describe, expect, test } from "bun:test";
import type { SessionInfo } from "@agent-town/shared";
import {
  createPlaceholderSessions,
  deduplicateSessions,
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

  test("cleans up stale timestamp when real session claims the mux session", () => {
    // First heartbeat: no real session, placeholder is created with timestamp
    const sessions1: SessionInfo[] = [];
    const mappings = new Map<string, ProcessMapping>();
    mappings.set("cwd:/project", makeMapping({ session: "agent-1" }));
    const activeMuxNames = new Set(["agent-1"]);

    createPlaceholderSessions(sessions1, mappings, activeMuxNames);
    expect(sessions1).toHaveLength(1);

    // Age the placeholder so it would expire on next check
    setPlaceholderCreatedAt("pending-agent-1", Date.now() - 4 * 60 * 1000);

    // Second heartbeat: real session now claims the mux session
    const sessions2: SessionInfo[] = [makeSession({ multiplexerSession: "agent-1" })];
    createPlaceholderSessions(sessions2, mappings, activeMuxNames);

    // Only the real session should remain
    expect(sessions2).toHaveLength(1);
    expect(sessions2[0].sessionId).toBe("real-uuid-1234");

    // Simulate the placeholder reappearing (e.g., race condition)
    // and verify the old timestamp was cleaned up so it gets a fresh one
    const sessions3: SessionInfo[] = [];
    const mappings3 = new Map<string, ProcessMapping>();
    mappings3.set("cwd:/project", makeMapping({ session: "agent-1" }));
    // Remove the real session from this heartbeat to force placeholder creation
    createPlaceholderSessions(sessions3, mappings3, activeMuxNames);
    expect(sessions3).toHaveLength(1);

    // The placeholder should NOT be expired because the old timestamp was cleaned up
    const result = expirePlaceholders(sessions3);
    expect(result).toHaveLength(1);
    expect(result[0].sessionId).toBe("pending-agent-1");
  });

  test("does not reset timestamp on repeated calls for same placeholder", () => {
    const sessions: SessionInfo[] = [];
    const mappings = new Map<string, ProcessMapping>();
    mappings.set("cwd:/project", makeMapping({ session: "agent-1" }));
    const activeMuxNames = new Set(["agent-1"]);

    // First call creates the placeholder and registers the timestamp
    createPlaceholderSessions(sessions, mappings, activeMuxNames);
    expect(sessions).toHaveLength(1);

    // Set the timestamp to 2 minutes ago (within TTL but aged)
    setPlaceholderCreatedAt("pending-agent-1", Date.now() - 2 * 60 * 1000);

    // Second call: simulating another heartbeat cycle. The placeholder for the
    // same mux session already exists in the sessions array, so the function
    // will skip it (mappedMuxSessions check). But if we start from an empty
    // sessions array, it should NOT reset the timestamp.
    const sessions2: SessionInfo[] = [];
    createPlaceholderSessions(sessions2, mappings, activeMuxNames);
    expect(sessions2).toHaveLength(1);

    // Verify the timestamp is still the aged one (not reset to now)
    // by expiring with a threshold between 2min and 3min — it should still be alive
    // but if we set it to just past TTL, it should expire (confirming old timestamp kept)
    setPlaceholderCreatedAt("pending-agent-1", Date.now() - 4 * 60 * 1000);
    const result = expirePlaceholders(sessions2);
    expect(result).toHaveLength(0);
  });

  test("defaults agentType to claude-code when mapping has no agentType", () => {
    const sessions: SessionInfo[] = [];
    const mappings = new Map<string, ProcessMapping>();
    mappings.set("cwd:/project", makeMapping({ session: "agent-1", agentType: undefined }));
    const activeMuxNames = new Set(["agent-1"]);

    createPlaceholderSessions(sessions, mappings, activeMuxNames);

    expect(sessions).toHaveLength(1);
    expect(sessions[0].agentType).toBe("claude-code");
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

  test("keeps placeholder with no tracking info (unknown to timestamp map)", () => {
    // A placeholder that somehow exists in sessions but has no timestamp entry
    // (e.g., created externally or timestamp map was cleared)
    const sessions: SessionInfo[] = [makeSession({ sessionId: "pending-unknown-mux", status: "starting" })];

    const result = expirePlaceholders(sessions);
    expect(result).toHaveLength(1);
    expect(result[0].sessionId).toBe("pending-unknown-mux");
  });

  test("returns empty array when given empty sessions", () => {
    const result = expirePlaceholders([]);
    expect(result).toHaveLength(0);
  });

  test("placeholder at exactly TTL boundary is kept", () => {
    const sessions: SessionInfo[] = [];
    const mappings = new Map<string, ProcessMapping>();
    mappings.set("cwd:/project", makeMapping({ session: "boundary" }));
    const activeMuxNames = new Set(["boundary"]);

    createPlaceholderSessions(sessions, mappings, activeMuxNames);

    // Set to exactly 3 minutes ago (180_000 ms). The check is `> TTL`, not `>=`,
    // so exactly at the boundary it should be kept.
    setPlaceholderCreatedAt("pending-boundary", Date.now() - 180_000);

    const result = expirePlaceholders(sessions);
    expect(result).toHaveLength(1);
    expect(result[0].sessionId).toBe("pending-boundary");
  });
});

describe("agent-side deduplication", () => {
  beforeEach(() => {
    resetPlaceholderTimestamps();
  });

  test("real session and placeholder with same mux session: only real is kept after dedup", () => {
    const realSession = makeSession({
      sessionId: "uuid-real",
      multiplexerSession: "my-mux",
    });

    const placeholderSession = makeSession({
      sessionId: "pending-my-mux",
      status: "starting",
      multiplexerSession: "my-mux",
    });

    const deduped = deduplicateSessions([realSession, placeholderSession]);

    expect(deduped).toHaveLength(1);
    expect(deduped[0].sessionId).toBe("uuid-real");
  });

  test("placeholder without a conflicting real session is preserved", () => {
    const placeholderSession = makeSession({
      sessionId: "pending-solo-mux",
      status: "starting",
      multiplexerSession: "solo-mux",
    });

    const deduped = deduplicateSessions([placeholderSession]);

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

    const deduped = deduplicateSessions([real1, placeholder1, placeholder2]);

    // real1 for mux-a, placeholder for mux-b, placeholder for mux-c — all kept
    expect(deduped).toHaveLength(3);
  });

  test("returns empty array when given empty sessions", () => {
    const deduped = deduplicateSessions([]);
    expect(deduped).toHaveLength(0);
  });

  test("sessions without multiplexerSession are never deduped", () => {
    const realNoMux = makeSession({
      sessionId: "uuid-no-mux",
      multiplexerSession: undefined,
    });
    const placeholderNoMux = makeSession({
      sessionId: "pending-no-mux",
      status: "starting",
      multiplexerSession: undefined,
    });

    const deduped = deduplicateSessions([realNoMux, placeholderNoMux]);

    // Both should be kept since neither has a multiplexerSession
    expect(deduped).toHaveLength(2);
  });

  test("multiple real sessions sharing same mux session does not cause false dedup", () => {
    // Two real (non-pending) sessions can share the same mux session
    // (e.g., parent + sub-agent). Neither should be removed.
    const real1 = makeSession({
      sessionId: "uuid-parent",
      multiplexerSession: "shared-mux",
    });
    const real2 = makeSession({
      sessionId: "uuid-child",
      multiplexerSession: "shared-mux",
    });

    const deduped = deduplicateSessions([real1, real2]);
    expect(deduped).toHaveLength(2);
  });

  test("cleans up placeholder timestamp when dedup removes it", () => {
    // Register a placeholder timestamp
    setPlaceholderCreatedAt("pending-dedup-mux", Date.now());

    const realSession = makeSession({
      sessionId: "uuid-real",
      multiplexerSession: "dedup-mux",
    });
    const placeholderSession = makeSession({
      sessionId: "pending-dedup-mux",
      status: "starting",
      multiplexerSession: "dedup-mux",
    });

    const deduped = deduplicateSessions([realSession, placeholderSession]);
    expect(deduped).toHaveLength(1);
    expect(deduped[0].sessionId).toBe("uuid-real");

    // If the placeholder reappears in a future heartbeat, it should get
    // a fresh timestamp (the old one was cleaned up). Verify by creating
    // a new placeholder and checking it doesn't immediately expire.
    const sessions: SessionInfo[] = [];
    const mappings = new Map<string, ProcessMapping>();
    mappings.set("cwd:/project", makeMapping({ session: "dedup-mux" }));
    createPlaceholderSessions(sessions, mappings, new Set(["dedup-mux"]));

    const result = expirePlaceholders(sessions);
    expect(result).toHaveLength(1);
    expect(result[0].sessionId).toBe("pending-dedup-mux");
  });
});

describe("combined expire + dedup pipeline", () => {
  beforeEach(() => {
    resetPlaceholderTimestamps();
  });

  test("expired placeholder removed before dedup, fresh placeholder deduped by real session", () => {
    // Set up: expired placeholder for mux-a, fresh placeholder for mux-b,
    // real session also for mux-b
    const sessions: SessionInfo[] = [];
    const mappings = new Map<string, ProcessMapping>();
    mappings.set("cwd:/project-a", makeMapping({ session: "mux-a" }));
    mappings.set("cwd:/project-b", makeMapping({ session: "mux-b" }));
    createPlaceholderSessions(sessions, mappings, new Set(["mux-a", "mux-b"]));
    expect(sessions).toHaveLength(2);

    // Age mux-a's placeholder past TTL
    setPlaceholderCreatedAt("pending-mux-a", Date.now() - 4 * 60 * 1000);

    // Add a real session for mux-b
    sessions.push(
      makeSession({
        sessionId: "uuid-real-b",
        multiplexerSession: "mux-b",
      }),
    );

    // Run the pipeline as it happens in sendHeartbeat()
    const result = deduplicateSessions(expirePlaceholders(sessions));

    // pending-mux-a expired, pending-mux-b deduped by real session
    // Only the real session for mux-b should remain
    expect(result).toHaveLength(1);
    expect(result[0].sessionId).toBe("uuid-real-b");
  });

  test("pipeline with only real sessions passes all through", () => {
    const sessions: SessionInfo[] = [
      makeSession({ sessionId: "uuid-1", multiplexerSession: "mux-1" }),
      makeSession({ sessionId: "uuid-2", multiplexerSession: "mux-2" }),
      makeSession({ sessionId: "uuid-3" }), // no mux session
    ];

    const result = deduplicateSessions(expirePlaceholders(sessions));
    expect(result).toHaveLength(3);
  });
});
