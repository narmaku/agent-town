import { describe, expect, test } from "bun:test";

import { CodexProvider } from "./index";
import { buildCodexDeleteCommand, deleteCodexSessionData } from "./session-discovery";

const SESSION_ID = "550e8400-e29b-41d4-a716-446655440000";

describe("CodexProvider", () => {
  const provider = new CodexProvider();

  test("declares Codex identity and TUI input capabilities", () => {
    expect(provider.type).toBe("codex");
    expect(provider.displayName).toBe("Codex CLI");
    expect(provider.binaryName).toBe("codex");
    expect(provider.terminal).toEqual({
      inputMode: "bracketed-paste",
      startupMode: "tui",
      autonomousDisclaimer: false,
    });
  });

  test("builds exact launch commands", () => {
    expect(provider.buildLaunchCommand({})).toEqual(["codex"]);
    expect(provider.buildLaunchCommand({ model: "gpt-5.3-codex" })).toEqual(["codex", "--model", "gpt-5.3-codex"]);
    expect(provider.buildLaunchCommand({ autonomous: true })).toEqual([
      "codex",
      "--dangerously-bypass-approvals-and-sandbox",
    ]);
  });

  test("builds exact positional resume commands", () => {
    expect(provider.buildResumeCommand({ sessionId: SESSION_ID })).toEqual(["codex", "resume", SESSION_ID]);
    expect(
      provider.buildResumeCommand({ sessionId: SESSION_ID, model: "gpt-5.3-codex", autonomous: true }),
    ).toEqual([
      "codex",
      "resume",
      SESSION_ID,
      "--model",
      "gpt-5.3-codex",
      "--dangerously-bypass-approvals-and-sandbox",
    ]);
  });

  test("has no hook event support", () => {
    expect(provider.handleHookEvent({ type: "anything" })).toBeNull();
  });
});

describe("Codex native deletion", () => {
  test("builds an argument-array forced delete command only for UUIDs", () => {
    expect(buildCodexDeleteCommand(SESSION_ID)).toEqual(["codex", "delete", "--force", SESSION_ID]);
    expect(buildCodexDeleteCommand("../../other.jsonl")).toBeNull();
  });

  test("reports nonzero delete status without unlinking paths", async () => {
    const calls: string[][] = [];
    const deleted = await deleteCodexSessionData(SESSION_ID, async (command) => {
      calls.push(command);
      return 1;
    });
    expect(deleted).toBe(false);
    expect(calls).toEqual([["codex", "delete", "--force", SESSION_ID]]);
  });
});
