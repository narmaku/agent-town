import { describe, expect, test } from "bun:test";
import type { MachineInfo, SessionInfo } from "@agent-town/shared";
import { deriveRecentDirectories } from "./LaunchAgentModal";

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
});
