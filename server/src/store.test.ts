import { describe, expect, test, beforeEach } from "bun:test";
import { upsertMachine, getAllMachines, getMachine } from "./store";
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
