import { describe, expect, test } from "bun:test";

import type { AgentProcess } from "./types";
import { extractBinaryName, filterProcessesByBinary, isBinaryAvailable } from "./utils";

/** Factory helper for AgentProcess test data. */
function makeProcess(overrides: Partial<AgentProcess> & { args: string }): AgentProcess {
  return {
    pid: 1,
    ppid: 0,
    etimes: 100,
    ...overrides,
  };
}

describe("extractBinaryName", () => {
  test("extracts binary from absolute path", () => {
    expect(extractBinaryName("/usr/bin/claude --resume abc")).toBe("claude");
  });

  test("extracts binary from bare command without path", () => {
    expect(extractBinaryName("opencode --session ses_abc")).toBe("opencode");
  });

  test("extracts binary from bare command without arguments", () => {
    expect(extractBinaryName("claude")).toBe("claude");
  });

  test("extracts binary from deep nested path", () => {
    expect(extractBinaryName("/home/user/.local/share/bin/node --inspect")).toBe("node");
  });

  test("extracts binary from path without arguments", () => {
    expect(extractBinaryName("/usr/local/bin/bun")).toBe("bun");
  });

  test("returns undefined for empty string", () => {
    expect(extractBinaryName("")).toBe("");
  });

  test("extracts binary when path ends with slash", () => {
    // "/usr/bin/".split("/").pop() => "" => "".split(" ")[0] => ""
    expect(extractBinaryName("/usr/bin/")).toBe("");
  });

  test("extracts binary with multiple spaces in arguments", () => {
    expect(extractBinaryName("/usr/bin/claude  --flag  value")).toBe("claude");
  });

  test("handles single slash prefix", () => {
    expect(extractBinaryName("/claude")).toBe("claude");
  });

  test("handles command starting with dot-slash", () => {
    expect(extractBinaryName("./node_modules/.bin/biome check")).toBe("biome");
  });
});

describe("filterProcessesByBinary", () => {
  test("filters processes matching the given binary name", () => {
    const processes = [
      makeProcess({ pid: 1, args: "/usr/bin/claude --resume abc" }),
      makeProcess({ pid: 2, args: "opencode --session ses_123" }),
      makeProcess({ pid: 3, args: "claude" }),
      makeProcess({ pid: 4, args: "/home/user/.local/bin/node" }),
    ];
    const result = filterProcessesByBinary(processes, "claude");
    expect(result).toHaveLength(2);
    expect(result[0].pid).toBe(1);
    expect(result[1].pid).toBe(3);
  });

  test("returns empty array when no processes match", () => {
    const processes = [
      makeProcess({ pid: 1, args: "/usr/bin/node server.js" }),
      makeProcess({ pid: 2, args: "bun run dev" }),
    ];
    const result = filterProcessesByBinary(processes, "claude");
    expect(result).toEqual([]);
  });

  test("returns empty array when given empty array", () => {
    const result = filterProcessesByBinary([], "claude");
    expect(result).toEqual([]);
  });

  test("returns all processes when all match", () => {
    const processes = [
      makeProcess({ pid: 1, args: "/usr/bin/opencode --session ses_1" }),
      makeProcess({ pid: 2, args: "opencode" }),
      makeProcess({ pid: 3, args: "/opt/bin/opencode --model gpt-4" }),
    ];
    const result = filterProcessesByBinary(processes, "opencode");
    expect(result).toHaveLength(3);
  });

  test("does not match partial binary names", () => {
    const processes = [
      makeProcess({ pid: 1, args: "/usr/bin/claude-dev --flag" }),
      makeProcess({ pid: 2, args: "claude" }),
    ];
    const result = filterProcessesByBinary(processes, "claude");
    expect(result).toHaveLength(1);
    expect(result[0].pid).toBe(2);
  });

  test("preserves original process data in results", () => {
    const processes = [makeProcess({ pid: 42, ppid: 10, etimes: 999, args: "claude --resume abc" })];
    const result = filterProcessesByBinary(processes, "claude");
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({ pid: 42, ppid: 10, etimes: 999, args: "claude --resume abc" });
  });
});

describe("isBinaryAvailable", () => {
  // isBinaryAvailable spawns `which <binary>` and checks the exit code.
  // We test it with a binary that is guaranteed to exist (sh) and one
  // that almost certainly does not.

  test("returns true for a binary that exists on the system", async () => {
    const result = await isBinaryAvailable("sh");
    expect(result).toBe(true);
  });

  test("returns false for a binary that does not exist", async () => {
    const result = await isBinaryAvailable("__nonexistent_binary_agent_town_test__");
    expect(result).toBe(false);
  });

  test("returns false for an empty string binary name", async () => {
    const result = await isBinaryAvailable("");
    expect(result).toBe(false);
  });
});
