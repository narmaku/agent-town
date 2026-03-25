import { describe, expect, test } from "bun:test";
import type { Heartbeat } from "@agent-town/shared";
import {
  addPendingSession,
  getAllMachines,
  getMachine,
  getSavedSessionName,
  getSettings,
  renameSession,
  updateSettings,
  upsertMachine,
} from "./store";

function makeHeartbeat(overrides: Partial<Heartbeat> = {}): Heartbeat {
  return {
    machineId: "test-machine-1",
    hostname: "test-host",
    platform: "linux",
    sessions: [],
    multiplexers: ["zellij"],
    multiplexerSessions: [],
    availableAgents: ["claude-code"],
    terminalPort: 4681,
    timestamp: new Date().toISOString(),
    ...overrides,
  };
}

describe("store", () => {
  test("upsertMachine stores and retrieves a machine", () => {
    const heartbeat = makeHeartbeat();
    upsertMachine(heartbeat);

    const machine = getMachine("test-machine-1");
    expect(machine).not.toBeUndefined();
    expect(machine?.hostname).toBe("test-host");
    expect(machine?.platform).toBe("linux");
    expect(machine?.multiplexers).toEqual(["zellij"]);
  });

  test("upsertMachine updates existing machine", () => {
    upsertMachine(makeHeartbeat({ sessions: [] }));
    upsertMachine(
      makeHeartbeat({
        sessions: [
          {
            sessionId: "s1",
            slug: "test",
            projectPath: "/home/user/project",
            projectName: "project",
            gitBranch: "main",
            status: "working",
            lastActivity: new Date().toISOString(),
            lastMessage: "Working on it",
            cwd: "/home/user/project",
          },
        ],
      }),
    );

    const machine = getMachine("test-machine-1");
    expect(machine?.sessions).toHaveLength(1);
    expect(machine?.sessions[0].status).toBe("working");
  });

  test("getAllMachines returns all non-expired machines", () => {
    upsertMachine(makeHeartbeat({ machineId: "m1", hostname: "host1" }));
    upsertMachine(makeHeartbeat({ machineId: "m2", hostname: "host2" }));

    const machines = getAllMachines();
    expect(machines.length).toBeGreaterThanOrEqual(2);
  });

  test("renameSession applies custom name", () => {
    upsertMachine(
      makeHeartbeat({
        machineId: "rename-test",
        sessions: [
          {
            sessionId: "s1",
            slug: "original-slug",
            projectPath: "/project",
            projectName: "project",
            gitBranch: "main",
            status: "working",
            lastActivity: new Date().toISOString(),
            lastMessage: "",
            cwd: "/project",
          },
        ],
      }),
    );

    const ok = renameSession("rename-test", "s1", "My Custom Name");
    expect(ok).toBe(true);

    const machine = getMachine("rename-test");
    expect(machine?.sessions[0].customName).toBe("My Custom Name");
  });

  test("renameSession persists across heartbeats", () => {
    const session = {
      sessionId: "s2",
      slug: "test-slug",
      projectPath: "/project",
      projectName: "project",
      gitBranch: "main",
      status: "working" as const,
      lastActivity: new Date().toISOString(),
      lastMessage: "",
      cwd: "/project",
    };

    upsertMachine(makeHeartbeat({ machineId: "persist-test", sessions: [session] }));
    renameSession("persist-test", "s2", "Renamed");

    // Simulate a new heartbeat (agent sends fresh data without customName)
    upsertMachine(makeHeartbeat({ machineId: "persist-test", sessions: [session] }));

    const machine = getMachine("persist-test");
    expect(machine?.sessions[0].customName).toBe("Renamed");
  });

  test("renameSession with empty string clears name", () => {
    upsertMachine(
      makeHeartbeat({
        machineId: "clear-test",
        sessions: [
          {
            sessionId: "s3",
            slug: "slug",
            projectPath: "/p",
            projectName: "p",
            gitBranch: "",
            status: "idle",
            lastActivity: new Date().toISOString(),
            lastMessage: "",
            cwd: "/p",
          },
        ],
      }),
    );

    renameSession("clear-test", "s3", "Named");
    renameSession("clear-test", "s3", "");

    const machine = getMachine("clear-test");
    expect(machine?.sessions[0].customName).toBeUndefined();
  });

  test("renameSession returns false for unknown machine", () => {
    const ok = renameSession("nonexistent", "s1", "name");
    expect(ok).toBe(false);
  });

  test("deduplicates machines by hostname", () => {
    // Old agent registers with one machineId
    upsertMachine(
      makeHeartbeat({
        machineId: "old-id",
        hostname: "same-host",
        sessions: [],
      }),
    );

    // New agent registers with different machineId but same hostname
    upsertMachine(
      makeHeartbeat({
        machineId: "new-id",
        hostname: "same-host",
        sessions: [],
      }),
    );

    const machines = getAllMachines();
    const sameHostMachines = machines.filter((m) => m.hostname === "same-host");
    expect(sameHostMachines).toHaveLength(1);
    expect(sameHostMachines[0].machineId).toBe("new-id");
  });

  test("dedup migrates session renames to new machineId", () => {
    const session = {
      sessionId: "s-migrate",
      slug: "slug",
      projectPath: "/p",
      projectName: "p",
      gitBranch: "",
      status: "working" as const,
      lastActivity: new Date().toISOString(),
      lastMessage: "",
      cwd: "/p",
    };

    upsertMachine(makeHeartbeat({ machineId: "old-id-2", hostname: "migrate-host", sessions: [session] }));
    renameSession("old-id-2", "s-migrate", "My Name");

    // New agent with different id, same hostname
    upsertMachine(makeHeartbeat({ machineId: "new-id-2", hostname: "migrate-host", sessions: [session] }));

    const machine = getMachine("new-id-2");
    expect(machine).not.toBeUndefined();
    expect(machine?.sessions[0].customName).toBe("My Name");
  });

  test("auto-populated multiplexer name is persisted to sessionNames", () => {
    const session = {
      sessionId: "s-auto",
      slug: "test-slug",
      projectPath: "/project",
      projectName: "project",
      gitBranch: "",
      status: "working" as const,
      lastActivity: new Date().toISOString(),
      lastMessage: "",
      cwd: "/project",
      multiplexerSession: "my-cool-session",
    };

    upsertMachine(makeHeartbeat({ machineId: "auto-test", sessions: [session] }));

    // Auto-populated name should be persisted so getSavedSessionName returns it
    expect(getSavedSessionName("s-auto")).toBe("my-cool-session");
  });

  test("auto-populated name does not overwrite explicit rename", () => {
    const session = {
      sessionId: "s-no-overwrite",
      slug: "slug",
      projectPath: "/p",
      projectName: "p",
      gitBranch: "",
      status: "working" as const,
      lastActivity: new Date().toISOString(),
      lastMessage: "",
      cwd: "/p",
      multiplexerSession: "mux-name",
    };

    upsertMachine(makeHeartbeat({ machineId: "no-overwrite-test", sessions: [session] }));
    renameSession("no-overwrite-test", "s-no-overwrite", "User Chosen Name");

    // New heartbeat arrives with multiplexerSession — should NOT overwrite the explicit rename
    upsertMachine(makeHeartbeat({ machineId: "no-overwrite-test", sessions: [session] }));

    expect(getSavedSessionName("s-no-overwrite")).toBe("User Chosen Name");
    const machine = getMachine("no-overwrite-test");
    expect(machine?.sessions[0].customName).toBe("User Chosen Name");
  });

  test("auto-populated name survives multiplexer session disappearing", () => {
    const sessionWithMux = {
      sessionId: "s-survive",
      slug: "slug",
      projectPath: "/p",
      projectName: "p",
      gitBranch: "",
      status: "working" as const,
      lastActivity: new Date().toISOString(),
      lastMessage: "",
      cwd: "/p",
      multiplexerSession: "agent-session",
    };

    upsertMachine(makeHeartbeat({ machineId: "survive-test", sessions: [sessionWithMux] }));
    expect(getSavedSessionName("s-survive")).toBe("agent-session");

    // Multiplexer session dies — next heartbeat has no multiplexerSession
    const sessionWithoutMux = { ...sessionWithMux };
    delete (sessionWithoutMux as Record<string, unknown>).multiplexerSession;
    upsertMachine(makeHeartbeat({ machineId: "survive-test", sessions: [sessionWithoutMux] }));

    // Name should survive because it was persisted
    const machine = getMachine("survive-test");
    expect(machine?.sessions[0].customName).toBe("agent-session");
    expect(getSavedSessionName("s-survive")).toBe("agent-session");
  });

  test("pending session appears as starting placeholder in getAllMachines", () => {
    upsertMachine(makeHeartbeat({ machineId: "pending-test", hostname: "pending-host" }));

    addPendingSession("pending-test", "my-new-agent", "/home/user/project", "tmux");

    const machines = getAllMachines();
    const machine = machines.find((m) => m.machineId === "pending-test");
    expect(machine).not.toBeUndefined();

    const pending = machine?.sessions.find((s) => s.sessionId === "pending-my-new-agent");
    expect(pending).not.toBeUndefined();
    expect(pending?.status).toBe("starting");
    expect(pending?.multiplexer).toBe("tmux");
    expect(pending?.multiplexerSession).toBe("my-new-agent");
    expect(pending?.customName).toBe("my-new-agent");
    expect(pending?.projectPath).toBe("/home/user/project");
    expect(pending?.lastMessage).toContain("connect to the terminal");
  });

  test("pending session is removed when heartbeat matches by mux name", () => {
    upsertMachine(makeHeartbeat({ machineId: "pending-match", hostname: "pending-match-host" }));

    addPendingSession("pending-match", "agent-abc", "/home/user/project", "zellij");

    // Verify pending appears
    let machines = getAllMachines();
    let machine = machines.find((m) => m.machineId === "pending-match");
    expect(machine?.sessions.find((s) => s.status === "starting")).not.toBeUndefined();

    // Heartbeat arrives with a real session that has the same multiplexerSession name
    upsertMachine(
      makeHeartbeat({
        machineId: "pending-match",
        hostname: "pending-match-host",
        sessions: [
          {
            sessionId: "real-session-id",
            slug: "agent-abc",
            projectPath: "/home/user/project",
            projectName: "project",
            gitBranch: "main",
            status: "working",
            lastActivity: new Date().toISOString(),
            lastMessage: "Working on it",
            cwd: "/home/user/project",
            multiplexerSession: "agent-abc",
            multiplexer: "zellij",
          },
        ],
      }),
    );

    // Pending should be gone, replaced by the real session
    machines = getAllMachines();
    machine = machines.find((m) => m.machineId === "pending-match");
    expect(machine?.sessions.find((s) => s.status === "starting")).toBeUndefined();
    expect(machine?.sessions.find((s) => s.sessionId === "real-session-id")).not.toBeUndefined();
  });

  test("pending session is not duplicated if real session already has same mux name", () => {
    const session = {
      sessionId: "existing-s",
      slug: "existing-agent",
      projectPath: "/project",
      projectName: "project",
      gitBranch: "",
      status: "working" as const,
      lastActivity: new Date().toISOString(),
      lastMessage: "",
      cwd: "/project",
      multiplexerSession: "existing-agent",
      multiplexer: "tmux" as const,
    };

    upsertMachine(makeHeartbeat({ machineId: "no-dup-test", hostname: "no-dup-host", sessions: [session] }));
    addPendingSession("no-dup-test", "existing-agent", "/project", "tmux");

    const machines = getAllMachines();
    const machine = machines.find((m) => m.machineId === "no-dup-test");
    // Should only have the real session, not a pending duplicate
    expect(machine?.sessions).toHaveLength(1);
    expect(machine?.sessions[0].sessionId).toBe("existing-s");
  });

  test("getAllMachines excludes expired machines", () => {
    const oldTimestamp = new Date(Date.now() - 60_000).toISOString();
    upsertMachine(
      makeHeartbeat({
        machineId: "expired-machine",
        hostname: "old-host",
        timestamp: oldTimestamp,
      }),
    );

    const machines = getAllMachines();
    const expired = machines.find((m) => m.machineId === "expired-machine");
    expect(expired).toBeUndefined();
  });

  test("default settings include openTerminalFullscreen as true", () => {
    const settings = getSettings();
    expect(settings.openTerminalFullscreen).toBe(true);
  });

  test("updateSettings toggles openTerminalFullscreen", () => {
    const updated = updateSettings({ openTerminalFullscreen: false });
    expect(updated.openTerminalFullscreen).toBe(false);

    const retrieved = getSettings();
    expect(retrieved.openTerminalFullscreen).toBe(false);

    // Restore to default for other tests
    updateSettings({ openTerminalFullscreen: true });
  });

  test("updateSettings preserves other settings when patching openTerminalFullscreen", () => {
    const before = getSettings();
    updateSettings({ openTerminalFullscreen: false });
    const after = getSettings();

    expect(after.openTerminalFullscreen).toBe(false);
    expect(after.defaultMultiplexer).toBe(before.defaultMultiplexer);
    expect(after.theme).toBe(before.theme);
    expect(after.fontSize).toBe(before.fontSize);
    expect(after.enableKeyboardNavigation).toBe(before.enableKeyboardNavigation);

    // Restore
    updateSettings({ openTerminalFullscreen: true });
  });
});
