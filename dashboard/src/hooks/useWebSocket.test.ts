import { describe, expect, test } from "bun:test";
import type { MachineInfo, SessionStatus } from "@agent-town/shared";

import { type ActivityEvent, appendActivityEvents, buildActivityEvents } from "./useWebSocket";

function makeMachine(overrides: Partial<MachineInfo> = {}): MachineInfo {
  return {
    machineId: "machine-1",
    hostname: "workstation",
    platform: "linux",
    lastHeartbeat: new Date().toISOString(),
    sessions: [],
    multiplexers: ["zellij"],
    multiplexerSessions: [],
    availableAgents: ["claude-code"],
    ...overrides,
  };
}

function makeEvent(overrides: Partial<ActivityEvent> = {}): ActivityEvent {
  return {
    id: "test-event-1",
    timestamp: new Date().toISOString(),
    sessionId: "session-1",
    sessionName: "my-project",
    machineId: "machine-1",
    hostname: "workstation",
    agentType: "claude-code",
    fromStatus: "working",
    toStatus: "done",
    ...overrides,
  };
}

describe("buildActivityEvents", () => {
  const NOW = 1700000000000;

  test("returns empty array when no previous statuses exist", () => {
    const machines = [
      makeMachine({
        sessions: [
          {
            sessionId: "s1",
            agentType: "claude-code",
            slug: "my-project",
            projectPath: "/home/user/project",
            projectName: "project",
            gitBranch: "main",
            status: "working",
            lastActivity: new Date().toISOString(),
            lastMessage: "doing work",
            cwd: "/home/user/project",
          },
        ],
      }),
    ];
    const prevStatuses = new Map<string, SessionStatus>();

    const events = buildActivityEvents(machines, prevStatuses, NOW);

    expect(events).toHaveLength(0);
  });

  test("returns empty array when status has not changed", () => {
    const machines = [
      makeMachine({
        sessions: [
          {
            sessionId: "s1",
            agentType: "claude-code",
            slug: "my-project",
            projectPath: "/home/user/project",
            projectName: "project",
            gitBranch: "main",
            status: "working",
            lastActivity: new Date().toISOString(),
            lastMessage: "doing work",
            cwd: "/home/user/project",
          },
        ],
      }),
    ];
    const prevStatuses = new Map<string, SessionStatus>([["s1", "working"]]);

    const events = buildActivityEvents(machines, prevStatuses, NOW);

    expect(events).toHaveLength(0);
  });

  test("creates an event when status changes", () => {
    const machines = [
      makeMachine({
        sessions: [
          {
            sessionId: "s1",
            agentType: "claude-code",
            slug: "my-project",
            projectPath: "/home/user/project",
            projectName: "project",
            gitBranch: "main",
            status: "done",
            lastActivity: new Date().toISOString(),
            lastMessage: "finished",
            cwd: "/home/user/project",
          },
        ],
      }),
    ];
    const prevStatuses = new Map<string, SessionStatus>([["s1", "working"]]);

    const events = buildActivityEvents(machines, prevStatuses, NOW);

    expect(events).toHaveLength(1);
    expect(events[0].sessionId).toBe("s1");
    expect(events[0].fromStatus).toBe("working");
    expect(events[0].toStatus).toBe("done");
    expect(events[0].sessionName).toBe("my-project");
    expect(events[0].machineId).toBe("machine-1");
    expect(events[0].hostname).toBe("workstation");
    expect(events[0].agentType).toBe("claude-code");
  });

  test("uses customName over slug when available", () => {
    const machines = [
      makeMachine({
        sessions: [
          {
            sessionId: "s1",
            agentType: "claude-code",
            slug: "my-project",
            customName: "Auth Refactor",
            projectPath: "/home/user/project",
            projectName: "project",
            gitBranch: "main",
            status: "done",
            lastActivity: new Date().toISOString(),
            lastMessage: "finished",
            cwd: "/home/user/project",
          },
        ],
      }),
    ];
    const prevStatuses = new Map<string, SessionStatus>([["s1", "working"]]);

    const events = buildActivityEvents(machines, prevStatuses, NOW);

    expect(events[0].sessionName).toBe("Auth Refactor");
  });

  test("creates events for multiple sessions across multiple machines", () => {
    const machines = [
      makeMachine({
        machineId: "m1",
        hostname: "workstation",
        sessions: [
          {
            sessionId: "s1",
            agentType: "claude-code",
            slug: "project-a",
            projectPath: "/a",
            projectName: "a",
            gitBranch: "main",
            status: "done",
            lastActivity: new Date().toISOString(),
            lastMessage: "",
            cwd: "/a",
          },
        ],
      }),
      makeMachine({
        machineId: "m2",
        hostname: "laptop",
        sessions: [
          {
            sessionId: "s2",
            agentType: "opencode",
            slug: "project-b",
            projectPath: "/b",
            projectName: "b",
            gitBranch: "dev",
            status: "error",
            lastActivity: new Date().toISOString(),
            lastMessage: "",
            cwd: "/b",
          },
          {
            sessionId: "s3",
            agentType: "opencode",
            slug: "project-c",
            projectPath: "/c",
            projectName: "c",
            gitBranch: "main",
            status: "working",
            lastActivity: new Date().toISOString(),
            lastMessage: "",
            cwd: "/c",
          },
        ],
      }),
    ];
    const prevStatuses = new Map<string, SessionStatus>([
      ["s1", "working"],
      ["s2", "working"],
      ["s3", "working"],
    ]);

    const events = buildActivityEvents(machines, prevStatuses, NOW);

    // s1: working -> done, s2: working -> error, s3: no change
    expect(events).toHaveLength(2);
    expect(events[0].sessionId).toBe("s1");
    expect(events[0].machineId).toBe("m1");
    expect(events[0].hostname).toBe("workstation");
    expect(events[1].sessionId).toBe("s2");
    expect(events[1].machineId).toBe("m2");
    expect(events[1].hostname).toBe("laptop");
    expect(events[1].agentType).toBe("opencode");
  });

  test("generates unique IDs for each event", () => {
    const machines = [
      makeMachine({
        sessions: [
          {
            sessionId: "s1",
            agentType: "claude-code",
            slug: "a",
            projectPath: "/a",
            projectName: "a",
            gitBranch: "main",
            status: "done",
            lastActivity: new Date().toISOString(),
            lastMessage: "",
            cwd: "/a",
          },
          {
            sessionId: "s2",
            agentType: "claude-code",
            slug: "b",
            projectPath: "/b",
            projectName: "b",
            gitBranch: "main",
            status: "error",
            lastActivity: new Date().toISOString(),
            lastMessage: "",
            cwd: "/b",
          },
        ],
      }),
    ];
    const prevStatuses = new Map<string, SessionStatus>([
      ["s1", "working"],
      ["s2", "working"],
    ]);

    const events = buildActivityEvents(machines, prevStatuses, NOW);

    expect(events[0].id).not.toBe(events[1].id);
  });

  test("includes correct timestamp from provided now parameter", () => {
    const machines = [
      makeMachine({
        sessions: [
          {
            sessionId: "s1",
            agentType: "claude-code",
            slug: "a",
            projectPath: "/a",
            projectName: "a",
            gitBranch: "main",
            status: "done",
            lastActivity: new Date().toISOString(),
            lastMessage: "",
            cwd: "/a",
          },
        ],
      }),
    ];
    const prevStatuses = new Map<string, SessionStatus>([["s1", "working"]]);

    const events = buildActivityEvents(machines, prevStatuses, NOW);

    expect(events[0].timestamp).toBe(new Date(NOW).toISOString());
  });

  test("does not create event for new sessions not in previous statuses", () => {
    const machines = [
      makeMachine({
        sessions: [
          {
            sessionId: "new-session",
            agentType: "claude-code",
            slug: "new",
            projectPath: "/new",
            projectName: "new",
            gitBranch: "main",
            status: "starting",
            lastActivity: new Date().toISOString(),
            lastMessage: "",
            cwd: "/new",
          },
        ],
      }),
    ];
    const prevStatuses = new Map<string, SessionStatus>([["old-session", "working"]]);

    const events = buildActivityEvents(machines, prevStatuses, NOW);

    expect(events).toHaveLength(0);
  });
});

describe("appendActivityEvents", () => {
  test("prepends new events in reverse order (newest first)", () => {
    const existing = [makeEvent({ id: "old-1", toStatus: "done" })];
    const newEvents = [makeEvent({ id: "new-1", toStatus: "working" }), makeEvent({ id: "new-2", toStatus: "error" })];

    const result = appendActivityEvents(existing, newEvents);

    expect(result).toHaveLength(3);
    expect(result[0].id).toBe("new-2");
    expect(result[1].id).toBe("new-1");
    expect(result[2].id).toBe("old-1");
  });

  test("caps at maxEvents", () => {
    const existing = Array.from({ length: 5 }, (_, i) => makeEvent({ id: `existing-${i}` }));
    const newEvents = [makeEvent({ id: "new-1" })];

    const result = appendActivityEvents(existing, newEvents, 4);

    expect(result).toHaveLength(4);
    expect(result[0].id).toBe("new-1");
    // Old events are trimmed from the end
    expect(result[3].id).toBe("existing-2");
  });

  test("returns existing feed unchanged when no new events", () => {
    const existing = [makeEvent({ id: "a" }), makeEvent({ id: "b" })];

    const result = appendActivityEvents(existing, []);

    expect(result).toHaveLength(2);
    expect(result[0].id).toBe("a");
    expect(result[1].id).toBe("b");
  });

  test("handles empty existing feed", () => {
    const newEvents = [makeEvent({ id: "first" })];

    const result = appendActivityEvents([], newEvents);

    expect(result).toHaveLength(1);
    expect(result[0].id).toBe("first");
  });

  test("caps at 200 events by default", () => {
    const existing = Array.from({ length: 199 }, (_, i) => makeEvent({ id: `e-${i}` }));
    const newEvents = Array.from({ length: 5 }, (_, i) => makeEvent({ id: `n-${i}` }));

    const result = appendActivityEvents(existing, newEvents);

    expect(result).toHaveLength(200);
  });

  test("does not mutate the input arrays", () => {
    const existing = [makeEvent({ id: "a" })];
    const newEvents = [makeEvent({ id: "b" })];
    const existingCopy = [...existing];
    const newEventsCopy = [...newEvents];

    appendActivityEvents(existing, newEvents);

    expect(existing).toEqual(existingCopy);
    expect(newEvents).toEqual(newEventsCopy);
  });

  test("new events accumulate normally after clearing (empty feed)", () => {
    // Simulates the state after clearActivity: feed is empty
    const clearedFeed: ActivityEvent[] = [];
    const newEvents = [
      makeEvent({ id: "post-clear-1", toStatus: "working" }),
      makeEvent({ id: "post-clear-2", toStatus: "error" }),
    ];

    const result = appendActivityEvents(clearedFeed, newEvents);

    expect(result).toHaveLength(2);
    expect(result[0].id).toBe("post-clear-2");
    expect(result[1].id).toBe("post-clear-1");
  });

  test("cleared feed does not contain any previous events", () => {
    // Build up a feed, then simulate clear by starting from empty
    const preClearFeed = [makeEvent({ id: "old-1" }), makeEvent({ id: "old-2" }), makeEvent({ id: "old-3" })];
    expect(preClearFeed).toHaveLength(3);

    // After clear, feed is empty
    const clearedFeed: ActivityEvent[] = [];
    expect(clearedFeed).toHaveLength(0);

    // New events after clear should not contain old events
    const postClearEvents = [makeEvent({ id: "new-after-clear" })];
    const result = appendActivityEvents(clearedFeed, postClearEvents);

    expect(result).toHaveLength(1);
    expect(result[0].id).toBe("new-after-clear");
    // None of the old event IDs should be present
    expect(result.find((e) => e.id === "old-1")).toBeUndefined();
    expect(result.find((e) => e.id === "old-2")).toBeUndefined();
    expect(result.find((e) => e.id === "old-3")).toBeUndefined();
  });
});
