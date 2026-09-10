import { describe, expect, test } from "bun:test";

import { extractCodexSessionIdFromArgs, filterCodexProcesses, matchCodexSessionByStartTime } from "./process-mapper";

const SESSION_ID = "550e8400-e29b-41d4-a716-446655440000";

describe("Codex process mapping", () => {
  test("matches direct Codex processes without substring collisions", () => {
    const processes = [
      { pid: 1, ppid: 0, etimes: 10, args: "codex" },
      { pid: 2, ppid: 0, etimes: 10, args: `/usr/local/bin/codex resume ${SESSION_ID}` },
      { pid: 3, ppid: 0, etimes: 10, args: "node /opt/codex/bin/codex.js" },
      { pid: 4, ppid: 0, etimes: 10, args: "codex-helper" },
      { pid: 5, ppid: 0, etimes: 10, args: "sh -c 'echo codex'" },
    ];

    expect(filterCodexProcesses(processes).map((process) => process.pid)).toEqual([1, 2, 3]);
  });

  test("extracts only a UUID after the resume subcommand", () => {
    expect(extractCodexSessionIdFromArgs(`codex resume ${SESSION_ID} --model gpt-5.3-codex`)).toBe(SESSION_ID);
    expect(extractCodexSessionIdFromArgs(`codex --model gpt-5.3-codex resume ${SESSION_ID}`)).toBe(SESSION_ID);
    expect(extractCodexSessionIdFromArgs("codex resume latest")).toBeUndefined();
    expect(extractCodexSessionIdFromArgs(`echo codex resume ${SESSION_ID}`)).toBeUndefined();
  });

  test("matches the nearest unclaimed same-cwd top-level session", () => {
    const start = Date.now() - 20_000;
    const candidates = [
      { id: "near", cwd: "/work", createdAtMs: start + 1_000, isSubagent: false },
      { id: "claimed", cwd: "/work", createdAtMs: start + 500, isSubagent: false },
      { id: "other-cwd", cwd: "/other", createdAtMs: start, isSubagent: false },
      { id: "child", cwd: "/work", createdAtMs: start, isSubagent: true },
    ];

    expect(matchCodexSessionByStartTime(candidates, "/work", start, new Set(["claimed"]))).toBe("near");
  });
});
