import { describe, expect, test } from "bun:test";
import type { SessionInfo } from "@agent-town/shared";

import {
  buildGroups,
  filterIdleSessions,
  filterSessionsByTime,
  sortSessions,
  visibleSessions,
} from "./session-grouping";

const HOUR_MS = 60 * 60 * 1000;

function makeSession(overrides: Partial<SessionInfo> = {}): SessionInfo {
  return {
    sessionId: "test-session",
    agentType: "claude-code",
    slug: "test",
    projectPath: "/tmp/project",
    projectName: "project",
    gitBranch: "main",
    status: "idle",
    lastActivity: new Date().toISOString(),
    lastMessage: "",
    cwd: "/tmp/project",
    ...overrides,
  };
}

function ago(ms: number): string {
  return new Date(Date.now() - ms).toISOString();
}

describe("sortSessions", () => {
  test("recent sorts newest lastActivity first", () => {
    const older = makeSession({ sessionId: "old", lastActivity: ago(5 * HOUR_MS) });
    const newer = makeSession({ sessionId: "new", lastActivity: ago(1 * HOUR_MS) });
    const result = sortSessions([older, newer], "recent");
    expect(result.map((s) => s.sessionId)).toEqual(["new", "old"]);
  });

  test("alphabetical prefers customName over slug and is case-insensitive", () => {
    const a = makeSession({ sessionId: "a", slug: "zebra" });
    const b = makeSession({ sessionId: "b", slug: "raw", customName: "Apple" });
    const result = sortSessions([a, b], "alphabetical");
    expect(result.map((s) => s.sessionId)).toEqual(["b", "a"]);
  });

  test("status orders action_required before working before idle", () => {
    const idle = makeSession({ sessionId: "idle", status: "idle" });
    const working = makeSession({ sessionId: "working", status: "working" });
    const action = makeSession({ sessionId: "action", status: "action_required" });
    const result = sortSessions([idle, working, action], "status");
    expect(result.map((s) => s.sessionId)).toEqual(["action", "working", "idle"]);
  });

  test("does not mutate the input array", () => {
    const input = [
      makeSession({ sessionId: "a", lastActivity: ago(1 * HOUR_MS) }),
      makeSession({ sessionId: "b", lastActivity: ago(5 * HOUR_MS) }),
    ];
    const snapshot = input.map((s) => s.sessionId);
    sortSessions(input, "recent");
    expect(input.map((s) => s.sessionId)).toEqual(snapshot);
  });
});

describe("filterSessionsByTime", () => {
  test("drops sessions older than the window", () => {
    const fresh = makeSession({ sessionId: "fresh", lastActivity: ago(1 * HOUR_MS) });
    const stale = makeSession({ sessionId: "stale", lastActivity: ago(48 * HOUR_MS) });
    const result = filterSessionsByTime([fresh, stale], "24h");
    expect(result.map((s) => s.sessionId)).toEqual(["fresh"]);
  });

  test("keeps a stale session that still has a live multiplexer", () => {
    const stale = makeSession({
      sessionId: "stale",
      lastActivity: ago(240 * HOUR_MS),
      multiplexerSession: "zellij-abc",
    });
    const result = filterSessionsByTime([stale], "24h");
    expect(result.map((s) => s.sessionId)).toEqual(["stale"]);
  });

  test("all keeps everything regardless of age", () => {
    const ancient = makeSession({ sessionId: "ancient", lastActivity: ago(1000 * HOUR_MS) });
    expect(filterSessionsByTime([ancient], "all")).toHaveLength(1);
  });
});

describe("filterIdleSessions", () => {
  test("passthrough when hideIdle is off", () => {
    const sessions = [makeSession({ status: "idle" }), makeSession({ status: "done" })];
    expect(filterIdleSessions(sessions, false)).toHaveLength(2);
  });

  test("removes idle and done when hideIdle is on", () => {
    const working = makeSession({ sessionId: "w", status: "working" });
    const idle = makeSession({ sessionId: "i", status: "idle" });
    const done = makeSession({ sessionId: "d", status: "done" });
    const result = filterIdleSessions([working, idle, done], true);
    expect(result.map((s) => s.sessionId)).toEqual(["w"]);
  });
});

describe("buildGroups", () => {
  test("none returns a single unlabelled group", () => {
    const sessions = [makeSession({ sessionId: "a" }), makeSession({ sessionId: "b" })];
    const groups = buildGroups(sessions, "none");
    expect(groups).toHaveLength(1);
    expect(groups[0][0]).toBe("");
    expect(groups[0][1]).toHaveLength(2);
  });

  test("status groups are ordered by attention rank and labelled", () => {
    const sessions = [
      makeSession({ sessionId: "idle", status: "idle" }),
      makeSession({ sessionId: "action", status: "action_required" }),
      makeSession({ sessionId: "working", status: "working" }),
    ];
    const groups = buildGroups(sessions, "status");
    expect(groups.map(([label]) => label)).toEqual(["Action Required", "Working", "Idle"]);
  });

  test("status grouping omits statuses with no sessions", () => {
    const groups = buildGroups([makeSession({ status: "working" })], "status");
    expect(groups.map(([label]) => label)).toEqual(["Working"]);
  });

  test("directory groups keyed by projectPath, sorted alphabetically", () => {
    const sessions = [
      makeSession({ sessionId: "z", projectPath: "/z/proj" }),
      makeSession({ sessionId: "a1", projectPath: "/a/proj" }),
      makeSession({ sessionId: "a2", projectPath: "/a/proj" }),
    ];
    const groups = buildGroups(sessions, "directory");
    expect(groups.map(([label]) => label)).toEqual(["/a/proj", "/z/proj"]);
    expect(groups[0][1].map((s) => s.sessionId)).toEqual(["a1", "a2"]);
  });
});

describe("visibleSessions", () => {
  test("flattens groups in render order matching group + sort order", () => {
    const idle = makeSession({ sessionId: "idle", status: "idle", lastActivity: ago(1 * HOUR_MS) });
    const action = makeSession({ sessionId: "action", status: "action_required", lastActivity: ago(2 * HOUR_MS) });
    const working = makeSession({ sessionId: "working", status: "working", lastActivity: ago(3 * HOUR_MS) });

    const result = visibleSessions([idle, action, working], {
      timeFilter: "all",
      groupMode: "status",
      hideIdle: false,
      sortMode: "status",
    });

    // Grouped by status (attention order), so action → working → idle.
    expect(result.map((s) => s.sessionId)).toEqual(["action", "working", "idle"]);
  });

  test("applies time filter, idle filter, grouping and sort together", () => {
    const keptRecent = makeSession({
      sessionId: "kept",
      status: "working",
      projectPath: "/a",
      lastActivity: ago(1 * HOUR_MS),
    });
    const droppedStale = makeSession({
      sessionId: "stale",
      status: "working",
      projectPath: "/a",
      lastActivity: ago(100 * HOUR_MS),
    });
    const droppedIdle = makeSession({
      sessionId: "idle",
      status: "idle",
      projectPath: "/a",
      lastActivity: ago(1 * HOUR_MS),
    });

    const result = visibleSessions([keptRecent, droppedStale, droppedIdle], {
      timeFilter: "24h",
      groupMode: "directory",
      hideIdle: true,
      sortMode: "recent",
    });

    expect(result.map((s) => s.sessionId)).toEqual(["kept"]);
  });
});
