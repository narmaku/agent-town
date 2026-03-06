import { describe, expect, test, beforeEach } from "bun:test";
import { upsertMachine, getAllMachines, getMachine, renameSession } from "./store";
import type { Heartbeat } from "@agent-town/shared";

function makeHeartbeat(overrides: Partial<Heartbeat> = {}): Heartbeat {
  return {
    machineId: "test-machine-1",
    hostname: "test-host",
    platform: "linux",
    sessions: [],
    multiplexers: ["zellij"],
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
    expect(machine!.hostname).toBe("test-host");
    expect(machine!.platform).toBe("linux");
    expect(machine!.multiplexers).toEqual(["zellij"]);
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
      })
    );

    const machine = getMachine("test-machine-1");
    expect(machine!.sessions).toHaveLength(1);
    expect(machine!.sessions[0].status).toBe("working");
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
      })
    );

    const ok = renameSession("rename-test", "s1", "My Custom Name");
    expect(ok).toBe(true);

    const machine = getMachine("rename-test");
    expect(machine!.sessions[0].customName).toBe("My Custom Name");
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
    expect(machine!.sessions[0].customName).toBe("Renamed");
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
      })
    );

    renameSession("clear-test", "s3", "Named");
    renameSession("clear-test", "s3", "");

    const machine = getMachine("clear-test");
    expect(machine!.sessions[0].customName).toBeUndefined();
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
      })
    );

    // New agent registers with different machineId but same hostname
    upsertMachine(
      makeHeartbeat({
        machineId: "new-id",
        hostname: "same-host",
        sessions: [],
      })
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

    upsertMachine(
      makeHeartbeat({ machineId: "old-id-2", hostname: "migrate-host", sessions: [session] })
    );
    renameSession("old-id-2", "s-migrate", "My Name");

    // New agent with different id, same hostname
    upsertMachine(
      makeHeartbeat({ machineId: "new-id-2", hostname: "migrate-host", sessions: [session] })
    );

    const machine = getMachine("new-id-2");
    expect(machine).not.toBeUndefined();
    expect(machine!.sessions[0].customName).toBe("My Name");
  });

  test("getAllMachines excludes expired machines", () => {
    const oldTimestamp = new Date(Date.now() - 60_000).toISOString();
    upsertMachine(
      makeHeartbeat({
        machineId: "expired-machine",
        hostname: "old-host",
        timestamp: oldTimestamp,
      })
    );

    const machines = getAllMachines();
    const expired = machines.find((m) => m.machineId === "expired-machine");
    expect(expired).toBeUndefined();
  });
});
