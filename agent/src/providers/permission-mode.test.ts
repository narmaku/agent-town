import { describe, expect, test } from "bun:test";
import { buildShellCommand, type PermissionMode } from "@agent-town/shared";
import { buildWrapperScript } from "../session-recovery";
import { ClaudeCodeProvider } from "./claude-code";
import { CodexProvider } from "./codex";
import { GeminiCliProvider } from "./gemini-cli";
import { OpenCodeProvider } from "./opencode";
import { PiProvider } from "./pi";

describe("provider permission modes", () => {
  for (const [provider, auto, yolo] of [
    [new ClaudeCodeProvider(), ["--permission-mode", "auto"], ["--dangerously-skip-permissions"]],
    [new CodexProvider(), ["--approve-for-me"], ["--yolo"]],
    [new GeminiCliProvider(), ["--approval-mode", "auto_edit"], ["--yolo"]],
  ] as const) {
    for (const [mode, flags] of [
      ["default", []],
      ["auto", auto],
      ["yolo", yolo],
    ] as const) {
      test(`${provider.type} ${mode} launch and resume use exact flags`, () => {
        const options = { permissionMode: mode as PermissionMode, model: "test-model" };
        expect(provider.buildLaunchCommand(options)).toEqual([provider.binaryName, "--model", "test-model", ...flags]);
        const resume = provider.buildResumeCommand({ ...options, sessionId: "session-1" });
        expect(resume.slice(-flags.length || resume.length)).toEqual(flags);
        if (mode === "auto") {
          expect(resume.some((arg) => arg.includes("dangerously") || arg === "--yolo")).toBe(false);
        }
      });
    }
  }

  test("OpenCode YOLO scopes both config formats to a single launch or resume process", () => {
    const provider = new OpenCodeProvider();
    const prefix = [
      "env",
      'OPENCODE_PERMISSION={"*":"allow"}',
      'OPENCODE_CLI_CONFIG_CONTENT={"session":{"permissions":"autoaccept"}}',
    ];
    expect(provider.buildLaunchCommand({ permissionMode: "yolo" })).toEqual([...prefix, "opencode"]);
    expect(provider.buildResumeCommand({ sessionId: "ses_123", permissionMode: "yolo" })).toEqual([
      ...prefix,
      "opencode",
      "--session",
      "ses_123",
    ]);
    expect(provider.buildLaunchCommand({ permissionMode: "default" })).toEqual(["opencode"]);
    expect(() => provider.buildLaunchCommand({ permissionMode: "auto" })).toThrow("Auto");
    expect(buildShellCommand(provider.buildLaunchCommand({ permissionMode: "yolo" }))).toContain(
      "'OPENCODE_PERMISSION=",
    );
  });

  test("Pi rejects explicit unsupported modes while old autonomous remains unchanged", () => {
    const provider = new PiProvider();
    expect(() => provider.buildLaunchCommand({ permissionMode: "yolo" })).toThrow("YOLO");
    expect(() => provider.buildResumeCommand({ sessionId: "a", permissionMode: "auto" })).toThrow("Auto");
    expect(provider.buildLaunchCommand({ autonomous: true })).toEqual(["pi"]);
  });

  test("Claude recovery applies Auto to both recovery paths without bypassing permission", () => {
    const script = buildWrapperScript({ muxSessionName: "demo", projectDir: "/tmp/demo", permissionMode: "auto" });
    expect(script.match(/--permission-mode auto/g)).toHaveLength(2);
    expect(script).not.toContain("--dangerously-skip-permissions");
  });
});
