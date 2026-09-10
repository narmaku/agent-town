import { describe, expect, test } from "bun:test";

import { extractPiSessionIdFromArgs, filterPiProcesses, matchPiSessionByStartTime } from "./process-mapper";

describe("Pi process mapping", () => {
  test("matches direct, compiled, and known Node or Bun Pi CLI shapes", () => {
    const processes = [
      { pid: 1, ppid: 0, etimes: 10, args: "pi" },
      { pid: 2, ppid: 0, etimes: 10, args: "/usr/local/bin/pi --model model" },
      { pid: 3, ppid: 0, etimes: 10, args: "node /opt/node_modules/@mariozechner/pi-coding-agent/dist/cli.js" },
      { pid: 4, ppid: 0, etimes: 10, args: "bun /repo/pi-coding-agent/src/cli.ts" },
      { pid: 5, ppid: 0, etimes: 10, args: "/usr/bin/env pi --session abc" },
    ];

    expect(filterPiProcesses(processes).map((process) => process.pid)).toEqual([1, 2, 3, 4, 5]);
  });

  test("rejects short-name and command-text collisions", () => {
    const processes = [
      { pid: 1, ppid: 0, etimes: 10, args: "pip install package" },
      { pid: 2, ppid: 0, etimes: 10, args: "pico README.md" },
      { pid: 3, ppid: 0, etimes: 10, args: "python /tmp/pi.py" },
      { pid: 4, ppid: 0, etimes: 10, args: "node /tmp/pi.js" },
      { pid: 5, ppid: 0, etimes: 10, args: "sh -c 'echo pi --session abc'" },
      { pid: 6, ppid: 0, etimes: 10, args: "agent-town --provider pi" },
    ];

    expect(filterPiProcesses(processes)).toEqual([]);
  });

  test("extracts safe explicit session IDs only from Pi commands", () => {
    expect(extractPiSessionIdFromArgs("pi --session project.session-7 --model model")).toBe("project.session-7");
    expect(extractPiSessionIdFromArgs("pi --session-id abc_123")).toBe("abc_123");
    expect(extractPiSessionIdFromArgs("pi --session=partial-id")).toBe("partial-id");
    expect(extractPiSessionIdFromArgs("pi --session ../../secret")).toBeUndefined();
    expect(extractPiSessionIdFromArgs("echo pi --session project.session-7")).toBeUndefined();
  });

  test("matches the nearest unclaimed same-cwd session near process start", () => {
    const start = Date.now();
    const candidates = [
      { id: "near", cwd: "/work", createdAtMs: start + 500 },
      { id: "claimed", cwd: "/work", createdAtMs: start + 100 },
      { id: "late", cwd: "/work", createdAtMs: start + 5 * 60_000 },
      { id: "other", cwd: "/other", createdAtMs: start },
    ];

    expect(matchPiSessionByStartTime(candidates, "/work", start, new Set(["claimed"]))).toBe("near");
  });
});
