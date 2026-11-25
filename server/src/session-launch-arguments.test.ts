import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { MachineInfo, SessionInfo } from "@agent-town/shared";
import { SessionLaunchArguments } from "./session-launch-arguments";

const launch = {
  machineId: "machine-a",
  agentType: "codex",
  multiplexer: "tmux",
  sessionName: "agent-one",
  extraArgs: ["--flag", "two words", ""],
} as const;

function session(sessionId: string, overrides: Partial<SessionInfo> = {}): SessionInfo {
  return {
    sessionId,
    agentType: "codex",
    slug: "session",
    projectPath: "/tmp",
    projectName: "tmp",
    gitBranch: "",
    status: "awaiting_input",
    lastActivity: new Date().toISOString(),
    lastMessage: "",
    cwd: "/tmp",
    multiplexer: "tmux",
    multiplexerSession: launch.sessionName,
    ...overrides,
  };
}

function machine(sessions: SessionInfo[]): Pick<MachineInfo, "machineId" | "multiplexerSessions" | "sessions"> {
  return { machineId: launch.machineId, multiplexerSessions: [], sessions };
}

test("matches real sessions after restart and preserves arguments by machine, harness and ID", () => {
  const dir = mkdtempSync(join(tmpdir(), "agent-town-launch-arguments-"));
  const args = [...launch.extraArgs];
  try {
    new SessionLaunchArguments(dir).record({ ...launch, extraArgs: args }, [session("older-id")]);

    const reloaded = new SessionLaunchArguments(dir);
    reloaded.reconcile(
      machine([
        session("older-id"),
        session("pending-agent-one"),
        session("other-harness", { agentType: "pi" }),
        session("other-multiplexer", { multiplexer: "zellij" }),
      ]),
    );
    expect(reloaded.get(launch.machineId, launch.agentType, "older-id")).toBeUndefined();
    expect(reloaded.get(launch.machineId, launch.agentType, "pending-agent-one")).toBeUndefined();
    reloaded.reconcile(machine([session("recorded-id")]));

    const saved = new SessionLaunchArguments(dir);
    expect(saved.get(launch.machineId, launch.agentType, "recorded-id")).toEqual(args);
    expect(saved.get("machine-b", launch.agentType, "recorded-id")).toBeUndefined();
    expect(saved.get(launch.machineId, "pi", "recorded-id")).toBeUndefined();
    expect(statSync(join(dir, "session-launch-arguments.json")).mode & 0o777).toBe(0o600);
    saved.forget(launch.machineId, launch.agentType, "recorded-id");
    expect(new SessionLaunchArguments(dir).get(launch.machineId, launch.agentType, "recorded-id")).toBeUndefined();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("captures a session that appeared during launch and clears pending args on terminal reuse", () => {
  const dir = mkdtempSync(join(tmpdir(), "agent-town-launch-arguments-"));
  try {
    const saved = new SessionLaunchArguments(dir);
    saved.record({ ...launch, extraArgs: [...launch.extraArgs] }, [], machine([session("fast-id")]));
    expect(saved.get(launch.machineId, launch.agentType, "fast-id")).toEqual([...launch.extraArgs]);

    saved.record({ ...launch, extraArgs: ["--old"] }, []);
    saved.record({ ...launch, extraArgs: [] }, []);
    saved.reconcile(machine([session("new-id")]));
    expect(saved.get(launch.machineId, launch.agentType, "new-id")).toBeUndefined();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
