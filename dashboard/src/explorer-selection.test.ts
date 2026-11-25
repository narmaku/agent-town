import { describe, expect, test } from "bun:test";
import type { MachineInfo, SessionInfo } from "@agent-town/shared";

import { type ExplorerSelection, resolveExplorerSelection } from "./explorer-selection";
import { visibleSessions } from "./session-grouping";

function makeSession(overrides: Partial<SessionInfo> = {}): SessionInfo {
  return {
    sessionId: "same-id",
    agentType: "claude-code",
    slug: "session",
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

function makeMachine(machineId: string, sessions: SessionInfo[]): MachineInfo {
  return {
    machineId,
    hostname: machineId,
    platform: "linux",
    lastHeartbeat: new Date().toISOString(),
    sessions,
    multiplexers: [],
    multiplexerSessions: [],
    availableAgents: ["claude-code"],
  };
}

describe("Explorer session selection", () => {
  test("resolves the exact machine and fresh session after a heartbeat", () => {
    const session = makeSession({ lastMessage: "Updated by heartbeat" });
    const machines = [makeMachine("a", [makeSession()]), makeMachine("b", [session])];
    const selection = { machineId: "b", sessionId: "same-id" };
    const resolved = resolveExplorerSelection(machines, selection);
    expect(resolved.session).toBe(session);
    expect(resolved.machine?.machineId).toBe("b");
    expect(resolved.selection).toBe(selection);
  });

  test("keeps an active pane when filters hide the selected session", () => {
    const session = makeSession({ status: "idle" });
    const machines = [makeMachine("a", [session])];
    expect(
      visibleSessions(machines[0].sessions, {
        hideIdle: true,
        timeFilter: "all",
        groupMode: "none",
        sortMode: "recent",
      }),
    ).toEqual([]);
    expect(resolveExplorerSelection(machines, { machineId: "a", sessionId: session.sessionId }).session).toBe(session);
  });

  test("clears deleted sessions and disconnected machines without crossing machines", () => {
    const selection = { machineId: "b", sessionId: "same-id" };
    expect(resolveExplorerSelection([makeMachine("a", [makeSession()])], selection).selection).toBeNull();
    expect(resolveExplorerSelection([makeMachine("b", [])], selection).selection).toBeNull();
    expect(resolveExplorerSelection([], null).selection).toBeNull();
  });

  test("waits for a successful launch to appear, then stops waiting", () => {
    const selection: ExplorerSelection = {
      machineId: "a",
      sessionId: "pending-new-agent",
      awaitingSession: true,
    };
    expect(resolveExplorerSelection([makeMachine("a", [])], selection).selection).toBe(selection);
    const pending = makeSession({ sessionId: "pending-new-agent", multiplexerSession: "new-agent" });
    const found = resolveExplorerSelection([makeMachine("a", [pending])], selection);
    expect(found.session).toBe(pending);
    expect(found.selection?.awaitingSession).toBe(false);
    expect(resolveExplorerSelection([makeMachine("a", [])], found.selection).selection).toBeNull();
    expect(resolveExplorerSelection([], selection).selection).toBeNull();
  });

  test("follows a pending ID to the real session on the same machine", () => {
    const selection: ExplorerSelection = { machineId: "a", sessionId: "pending-new-agent" };
    const real = makeSession({ sessionId: "real-id", multiplexerSession: "new-agent" });
    const found = resolveExplorerSelection([makeMachine("a", [real])], selection);
    expect(found.session).toBe(real);
    expect(found.selection).toMatchObject({ machineId: "a", sessionId: "real-id" });
    expect(resolveExplorerSelection([makeMachine("a", []), makeMachine("b", [real])], selection).selection).toBeNull();
  });
});
