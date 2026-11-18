import { describe, expect, test } from "bun:test";
import { filterProcessesByBinary } from "../utils";
import { OpenCodeProvider } from "./index";
import { extractOpenCodeSessionIdFromArgs } from "./process-mapper";

describe("OpenCodeProvider", () => {
  const provider = new OpenCodeProvider();

  test("has correct type and display name", () => {
    expect(provider.type).toBe("opencode");
    expect(provider.displayName).toBe("OpenCode");
    expect(provider.binaryName).toBe("opencode");
  });

  test("buildLaunchCommand with defaults returns array", () => {
    const parts = provider.buildLaunchCommand({});
    expect(parts).toEqual(["opencode"]);
  });

  test("buildLaunchCommand with model returns array with flag and value", () => {
    const parts = provider.buildLaunchCommand({ model: "anthropic/claude-opus-4-6" });
    expect(parts).toEqual(["opencode", "--model", "anthropic/claude-opus-4-6"]);
  });

  test("buildLaunchCommand ignores autonomous (config-based)", () => {
    const parts = provider.buildLaunchCommand({ autonomous: true });
    expect(parts).toEqual(["opencode"]);
  });

  test("buildResumeCommand with session ID returns array", () => {
    const parts = provider.buildResumeCommand({ sessionId: "ses_abc123" });
    expect(parts).toEqual(["opencode", "--session", "ses_abc123"]);
  });

  test("buildResumeCommand with model returns array", () => {
    const parts = provider.buildResumeCommand({
      sessionId: "ses_abc123",
      model: "anthropic/claude-opus-4-6",
    });
    expect(parts).toEqual(["opencode", "--session", "ses_abc123", "--model", "anthropic/claude-opus-4-6"]);
  });
});

describe("filterProcessesByBinary (opencode)", () => {
  test("filters only opencode binaries", () => {
    const processes = [
      { pid: 1, ppid: 0, etimes: 100, args: "/usr/bin/opencode --session abc" },
      { pid: 2, ppid: 0, etimes: 200, args: "claude --resume xyz" },
      { pid: 3, ppid: 0, etimes: 50, args: "opencode" },
      { pid: 4, ppid: 0, etimes: 300, args: "/home/user/.local/bin/node" },
    ];
    const result = filterProcessesByBinary(processes, "opencode");
    expect(result).toHaveLength(2);
    expect(result[0].pid).toBe(1);
    expect(result[1].pid).toBe(3);
  });
});

describe("extractOpenCodeSessionIdFromArgs", () => {
  test("extracts session ID from --session flag", () => {
    expect(extractOpenCodeSessionIdFromArgs("opencode --session ses_abc123")).toBe("ses_abc123");
  });

  test("extracts session ID from -s flag", () => {
    expect(extractOpenCodeSessionIdFromArgs("opencode -s ses_abc123")).toBe("ses_abc123");
  });

  test("returns undefined without session flag", () => {
    expect(extractOpenCodeSessionIdFromArgs("opencode")).toBeUndefined();
  });

  test("extracts session ID with other flags", () => {
    expect(
      extractOpenCodeSessionIdFromArgs("/usr/bin/opencode --session ses_abc123 --model anthropic/claude-opus-4-6"),
    ).toBe("ses_abc123");
  });
});
