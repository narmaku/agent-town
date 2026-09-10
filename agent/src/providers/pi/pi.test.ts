import { describe, expect, test } from "bun:test";

import { isPiCliAvailable, PiProvider } from "./index";

describe("PiProvider", () => {
  const provider = new PiProvider();

  test("declares Pi identity and TUI input capabilities", () => {
    expect(provider.type).toBe("pi");
    expect(provider.displayName).toBe("Pi");
    expect(provider.binaryName).toBe("pi");
    expect(provider.terminal).toEqual({
      inputMode: "bracketed-paste",
      startupMode: "tui",
      autonomousDisclaimer: false,
    });
  });

  test("builds exact launch and session resume commands", () => {
    expect(provider.buildLaunchCommand({})).toEqual(["pi"]);
    expect(provider.buildLaunchCommand({ model: "provider/model", autonomous: true })).toEqual([
      "pi",
      "--model",
      "provider/model",
    ]);
    expect(provider.buildResumeCommand({ sessionId: "project.session-7" })).toEqual([
      "pi",
      "--session",
      "project.session-7",
    ]);
    expect(
      provider.buildResumeCommand({ sessionId: "project.session-7", model: "provider/model", autonomous: true }),
    ).toEqual(["pi", "--session", "project.session-7", "--model", "provider/model"]);
  });

  test("does not claim hook event support", () => {
    expect(provider.handleHookEvent({ type: "anything" })).toBeNull();
  });

  test("verifies that the short pi binary is the coding agent", async () => {
    expect(
      await isPiCliAvailable(async () => ({
        exitCode: 0,
        output: "pi - AI coding assistant\nUsage: pi [options]\n--model <model>\n--session <path|id>",
      })),
    ).toBe(true);
    expect(await isPiCliAvailable(async () => ({ exitCode: 0, output: "Usage: pi [options]\nCalculate pi" }))).toBe(
      false,
    );
    expect(await isPiCliAvailable(async () => ({ exitCode: 0, output: "Pi coding agent" }))).toBe(false);
    expect(await isPiCliAvailable(async () => ({ exitCode: 0, output: "calculate digits of pi" }))).toBe(false);
    expect(await isPiCliAvailable(async () => ({ exitCode: 1, output: "" }))).toBe(false);
  });
});
