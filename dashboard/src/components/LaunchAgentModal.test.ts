import { describe, expect, test } from "bun:test";
import type { MachineInfo, SessionInfo } from "@agent-town/shared";
import { deriveRecentDirectories, resolveSelectedMachineId } from "./LaunchAgentModal";

function makeSession(overrides: Partial<SessionInfo> = {}): SessionInfo {
  return {
    sessionId: "test-id",
    agentType: "claude-code",
    slug: "test-slug",
    projectPath: "/home/user/project",
    projectName: "project",
    gitBranch: "main",
    status: "idle",
    lastActivity: "2025-01-01T00:00:00.000Z",
    lastMessage: "test",
    cwd: "/home/user/project",
    ...overrides,
  };
}

function makeMachine(sessions: SessionInfo[] = []): MachineInfo {
  return {
    machineId: "machine-1",
    hostname: "localhost",
    platform: "linux",
    lastHeartbeat: "2025-01-01T00:00:00.000Z",
    sessions,
    multiplexers: ["zellij"],
    multiplexerSessions: [],
    availableAgents: ["claude-code"],
  };
}

describe("deriveRecentDirectories", () => {
  test("returns empty array for undefined machine", () => {
    expect(deriveRecentDirectories(undefined)).toEqual([]);
  });

  test("returns empty array for machine with no sessions", () => {
    const machine = makeMachine([]);
    expect(deriveRecentDirectories(machine)).toEqual([]);
  });

  test("returns unique directories from sessions", () => {
    const machine = makeMachine([
      makeSession({ projectPath: "/home/user/project-a", lastActivity: "2025-01-03T00:00:00.000Z" }),
      makeSession({ projectPath: "/home/user/project-b", lastActivity: "2025-01-02T00:00:00.000Z" }),
      makeSession({ projectPath: "/home/user/project-a", lastActivity: "2025-01-01T00:00:00.000Z" }),
    ]);

    const result = deriveRecentDirectories(machine);
    expect(result).toEqual(["/home/user/project-a", "/home/user/project-b"]);
  });

  test("sorts by most recent activity (newest first)", () => {
    const machine = makeMachine([
      makeSession({ projectPath: "/home/user/old-project", lastActivity: "2025-01-01T00:00:00.000Z" }),
      makeSession({ projectPath: "/home/user/new-project", lastActivity: "2025-01-03T00:00:00.000Z" }),
      makeSession({ projectPath: "/home/user/mid-project", lastActivity: "2025-01-02T00:00:00.000Z" }),
    ]);

    const result = deriveRecentDirectories(machine);
    expect(result).toEqual(["/home/user/new-project", "/home/user/mid-project", "/home/user/old-project"]);
  });

  test("uses the latest activity when a directory has multiple sessions", () => {
    const machine = makeMachine([
      makeSession({ projectPath: "/home/user/project", lastActivity: "2025-01-01T00:00:00.000Z" }),
      makeSession({ projectPath: "/home/user/project", lastActivity: "2025-01-05T00:00:00.000Z" }),
      makeSession({ projectPath: "/home/user/other", lastActivity: "2025-01-03T00:00:00.000Z" }),
    ]);

    const result = deriveRecentDirectories(machine);
    // /home/user/project has latest activity (Jan 5), so it comes first
    expect(result).toEqual(["/home/user/project", "/home/user/other"]);
  });

  test("skips sessions with empty projectPath", () => {
    const machine = makeMachine([
      makeSession({ projectPath: "/home/user/project", lastActivity: "2025-01-01T00:00:00.000Z" }),
      makeSession({ projectPath: "", lastActivity: "2025-01-02T00:00:00.000Z" }),
    ]);

    const result = deriveRecentDirectories(machine);
    expect(result).toEqual(["/home/user/project"]);
  });

  test("returns single directory for single session", () => {
    const machine = makeMachine([
      makeSession({ projectPath: "/home/user/project", lastActivity: "2025-01-01T00:00:00.000Z" }),
    ]);

    const result = deriveRecentDirectories(machine);
    expect(result).toEqual(["/home/user/project"]);
  });

  test("skips sessions with undefined projectPath", () => {
    const machine = makeMachine([
      makeSession({ projectPath: "/home/user/project", lastActivity: "2025-01-01T00:00:00.000Z" }),
      makeSession({ projectPath: undefined as unknown as string, lastActivity: "2025-01-02T00:00:00.000Z" }),
    ]);

    const result = deriveRecentDirectories(machine);
    expect(result).toEqual(["/home/user/project"]);
  });

  test("handles machine with undefined sessions gracefully", () => {
    const machine = makeMachine([]);
    // Simulate old agent without sessions array
    (machine as Record<string, unknown>).sessions = undefined;
    expect(deriveRecentDirectories(machine)).toEqual([]);
  });

  test("handles machine with null sessions gracefully", () => {
    const machine = makeMachine([]);
    (machine as Record<string, unknown>).sessions = null;
    expect(deriveRecentDirectories(machine)).toEqual([]);
  });

  test("handles many directories and preserves ordering", () => {
    const sessions = Array.from({ length: 20 }, (_, i) =>
      makeSession({
        projectPath: `/home/user/project-${String(i).padStart(2, "0")}`,
        lastActivity: new Date(2025, 0, i + 1).toISOString(),
      }),
    );
    const machine = makeMachine(sessions);

    const result = deriveRecentDirectories(machine);
    expect(result).toHaveLength(20);
    // Most recent (Jan 20) should come first
    expect(result[0]).toBe("/home/user/project-19");
    // Oldest (Jan 1) should come last
    expect(result[result.length - 1]).toBe("/home/user/project-00");
  });
});

describe("resolveSelectedMachineId", () => {
  test("returns user-selected machineId when set", () => {
    const result = resolveSelectedMachineId("user-selected", undefined, "first-machine");
    expect(result).toBe("user-selected");
  });

  test("returns initialMachineId when no user selection and initialMachineId is provided", () => {
    const result = resolveSelectedMachineId("", "initial-machine", "first-machine");
    expect(result).toBe("initial-machine");
  });

  test("falls back to first machine when no user selection and no initialMachineId", () => {
    const result = resolveSelectedMachineId("", undefined, "first-machine");
    expect(result).toBe("first-machine");
  });

  test("returns empty string when nothing is available", () => {
    const result = resolveSelectedMachineId("", undefined, "");
    expect(result).toBe("");
  });

  test("user selection takes priority over initialMachineId", () => {
    const result = resolveSelectedMachineId("user-selected", "initial-machine", "first-machine");
    expect(result).toBe("user-selected");
  });

  test("initialMachineId takes priority over first machine", () => {
    const result = resolveSelectedMachineId("", "initial-machine", "first-machine");
    expect(result).toBe("initial-machine");
  });

  test("treats empty-string initialMachineId same as undefined and falls back to first machine", () => {
    const result = resolveSelectedMachineId("", "", "first-machine");
    expect(result).toBe("first-machine");
  });

  test("returns empty string when all inputs are empty strings", () => {
    const result = resolveSelectedMachineId("", "", "");
    expect(result).toBe("");
  });
});
