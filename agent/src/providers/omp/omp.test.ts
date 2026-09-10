import { describe, expect, test } from "bun:test";

import { isOmpCliAvailable, OmpProvider } from "./index";

describe("OmpProvider", () => {
  const provider = new OmpProvider();

  test("declares OMP identity and TUI input capabilities", () => {
    expect(provider.type).toBe("omp");
    expect(provider.displayName).toBe("OMP");
    expect(provider.binaryName).toBe("omp");
    expect(provider.terminal).toEqual({
      inputMode: "bracketed-paste",
      startupMode: "tui",
      autonomousDisclaimer: false,
    });
  });

  test("builds exact launch, resume, model, and yolo commands", () => {
    expect(provider.buildLaunchCommand({})).toEqual(["omp"]);
    expect(provider.buildLaunchCommand({ model: "openai/gpt-5.2", autonomous: true })).toEqual([
      "omp",
      "--model",
      "openai/gpt-5.2",
      "--yolo",
    ]);
    expect(provider.buildResumeCommand({ sessionId: "legacy.session-a" })).toEqual([
      "omp",
      "--resume",
      "legacy.session-a",
    ]);
    expect(
      provider.buildResumeCommand({
        sessionId: "0199a8d7-9d84-7000-a123-123456789abc",
        model: "anthropic/claude-opus-4.1",
        autonomous: true,
      }),
    ).toEqual([
      "omp",
      "--resume",
      "0199a8d7-9d84-7000-a123-123456789abc",
      "--model",
      "anthropic/claude-opus-4.1",
      "--yolo",
    ]);
  });

  test("does not claim hook event support", () => {
    expect(provider.handleHookEvent({ type: "anything" })).toBeNull();
  });

  test("verifies the installed binary identifies itself as OMP", async () => {
    expect(await isOmpCliAvailable(async () => ({ exitCode: 0, output: "omp/18.1.2" }))).toBe(true);
    expect(await isOmpCliAvailable(async () => ({ exitCode: 0, output: "omp v18.1.2" }))).toBe(true);
    expect(await isOmpCliAvailable(async () => ({ exitCode: 0, output: "Usage: unrelated" }))).toBe(false);
    expect(await isOmpCliAvailable(async () => ({ exitCode: 1, output: "omp v18.1.2" }))).toBe(false);
  });
});
