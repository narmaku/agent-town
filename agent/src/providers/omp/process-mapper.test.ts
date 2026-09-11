import { describe, expect, test } from "bun:test";

import { extractOmpSessionIdFromArgs, filterOmpProcesses, matchOmpSessionByStartTime } from "./process-mapper";

describe("OMP process mapping", () => {
  test("matches only direct OMP executables and known package entrypoints", () => {
    const processes = [
      { pid: 1, ppid: 0, etimes: 10, args: "omp" },
      { pid: 2, ppid: 0, etimes: 10, args: "/home/linuxbrew/.linuxbrew/bin/omp --model model" },
      { pid: 3, ppid: 0, etimes: 10, args: "/usr/bin/env omp -r abc" },
      { pid: 4, ppid: 0, etimes: 10, args: "bun /opt/oh-my-pi/packages/coding-agent/dist/cli.js" },
      { pid: 5, ppid: 0, etimes: 10, args: "node /opt/@oh-my-pi/pi-coding-agent/dist/cli.mjs" },
    ];
    expect(filterOmpProcesses(processes).map((process) => process.pid)).toEqual([1, 2, 3, 4, 5]);
  });

  test("rejects command text and similarly named programs", () => {
    const processes = [
      { pid: 1, ppid: 0, etimes: 10, args: "prompt --omp" },
      { pid: 2, ppid: 0, etimes: 10, args: "compositor omp" },
      { pid: 3, ppid: 0, etimes: 10, args: "python /tmp/omp.py" },
      { pid: 4, ppid: 0, etimes: 10, args: "sh -c 'echo omp --resume abc'" },
      { pid: 5, ppid: 0, etimes: 10, args: "agent-town --provider omp" },
      { pid: 6, ppid: 0, etimes: 10, args: "pi --session abc" },
    ];
    expect(filterOmpProcesses(processes)).toEqual([]);
  });

  test("extracts safe exact IDs from every supported explicit resume form", () => {
    expect(extractOmpSessionIdFromArgs("omp --resume legacy.session-a")).toBe("legacy.session-a");
    expect(extractOmpSessionIdFromArgs("omp -r 0199a8d7-9d84-7000-a123-123456789abc")).toBe(
      "0199a8d7-9d84-7000-a123-123456789abc",
    );
    expect(extractOmpSessionIdFromArgs("omp --resume=opaque_7")).toBe("opaque_7");
    expect(extractOmpSessionIdFromArgs("omp -r=legacy.hex-8")).toBe("legacy.hex-8");
    expect(extractOmpSessionIdFromArgs("omp --session old.session-9")).toBe("old.session-9");
    expect(extractOmpSessionIdFromArgs("omp --session=old_session_10")).toBe("old_session_10");
    expect(extractOmpSessionIdFromArgs("omp --resume ../../secret")).toBeUndefined();
    expect(extractOmpSessionIdFromArgs("echo omp --resume legacy.session-a")).toBeUndefined();
  });

  test("matches the nearest unclaimed exact-cwd session around process start", () => {
    const start = Date.now();
    const candidates = [
      { id: "near", cwd: "/work", createdAtMs: start + 500 },
      { id: "claimed", cwd: "/work", createdAtMs: start + 100 },
      { id: "late", cwd: "/work", createdAtMs: start + 5 * 60_000 },
      { id: "other", cwd: "/other", createdAtMs: start },
    ];
    expect(matchOmpSessionByStartTime(candidates, "/work", start, new Set(["claimed"]))).toBe("near");
  });
});
