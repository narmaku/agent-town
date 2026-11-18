import { describe, expect, test } from "bun:test";
import type { SessionInfo } from "@agent-town/shared";

import { applyScreenStatuses, detectScreenStatus } from "./screen-status";

function makeSession(overrides: Partial<SessionInfo> = {}): SessionInfo {
  return {
    sessionId: "s1",
    agentType: "claude-code",
    slug: "s1",
    projectPath: "/work",
    projectName: "work",
    gitBranch: "",
    status: "awaiting_input",
    lastActivity: new Date().toISOString(),
    lastMessage: "",
    cwd: "/work",
    multiplexer: "tmux",
    multiplexerSession: "agent-1",
    ...overrides,
  };
}

describe("detectScreenStatus", () => {
  test("detects approval prompts from each agent's TUI", () => {
    const screens = [
      "Bash command\n  rm -rf build\n\nDo you want to proceed?\n❯ 1. Yes\n  2. No",
      "Would you like to run the following command?\n  $ bun test\n› Yes, proceed",
      "Allow execution? (y/n)",
      "Permission required\n  edit src/app.ts\n  Allow once   Allow always   Reject",
    ];
    for (const screen of screens) {
      expect(detectScreenStatus(screen)).toBe("action_required");
    }
  });

  test("detects a running turn from the interrupt hint", () => {
    expect(detectScreenStatus("✻ Thinking… (12s · esc to interrupt)")).toBe("working");
    expect(detectScreenStatus("• Working (5s • Esc to interrupt)")).toBe("working");
  });

  test("prefers action_required when a prompt and spinner are both visible", () => {
    expect(detectScreenStatus("esc to interrupt\nDo you want to proceed?")).toBe("action_required");
  });

  test("ignores prompts that have scrolled above the visible tail", () => {
    const screen = ["Do you want to proceed?", ...Array.from({ length: 30 }, (_, i) => `line ${i}`)].join("\n");
    expect(detectScreenStatus(screen)).toBeUndefined();
  });

  test("returns undefined for an idle prompt or empty screen", () => {
    expect(detectScreenStatus("> \n  ? for shortcuts")).toBeUndefined();
    expect(detectScreenStatus("\n\n")).toBeUndefined();
  });
});

describe("applyScreenStatuses", () => {
  test("overrides status only for multiplexer sessions with a clear screen signal", async () => {
    const prompting = makeSession({ sessionId: "a", multiplexerSession: "prompting" });
    const quiet = makeSession({ sessionId: "b", multiplexerSession: "quiet", status: "awaiting_input" });
    const detached = makeSession({
      sessionId: "c",
      multiplexer: undefined,
      multiplexerSession: undefined,
      status: "idle",
    });
    const screens: Record<string, string> = { prompting: "Do you want to proceed?", quiet: "> " };
    const captured: string[] = [];

    await applyScreenStatuses([prompting, quiet, detached], async (_mux, session) => {
      captured.push(session);
      return screens[session] ?? null;
    });

    expect(prompting.status).toBe("action_required");
    expect(quiet.status).toBe("awaiting_input");
    expect(detached.status).toBe("idle");
    expect(captured.sort()).toEqual(["prompting", "quiet"]);
  });
});
