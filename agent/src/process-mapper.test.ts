import { describe, expect, test } from "bun:test";
import { extractSessionIdFromArgs, matchSessionByBirthTime, type SessionCandidate } from "./process-mapper";

describe("matchSessionByBirthTime", () => {
  const now = Date.now();

  test("matches JSONL created close to process start time", () => {
    const candidates: SessionCandidate[] = [
      { id: "session-new", birthtimeMs: now - 5_000 }, // created 5s ago
      { id: "session-old", birthtimeMs: now - 3600_000 }, // created 1h ago
    ];
    const processStartMs = now - 10_000; // process started 10s ago

    const result = matchSessionByBirthTime(candidates, processStartMs, new Set());
    expect(result).toBe("session-new"); // 5s diff, within 2min window
  });

  test("rejects JSONLs created long before the process started", () => {
    const candidates: SessionCandidate[] = [
      { id: "session-old", birthtimeMs: now - 3600_000 }, // created 1h ago
    ];
    const processStartMs = now - 60_000; // process started 1min ago
    // JSONL was created 59 minutes before the process started → no match

    const result = matchSessionByBirthTime(candidates, processStartMs, new Set());
    expect(result).toBeUndefined();
  });

  test("picks closest birth time when multiple candidates match", () => {
    const candidates: SessionCandidate[] = [
      { id: "session-close", birthtimeMs: now - 8_000 }, // 8s ago
      { id: "session-far", birthtimeMs: now - 90_000 }, // 90s ago
    ];
    const processStartMs = now - 10_000; // started 10s ago
    // session-close: diff=2s, session-far: diff=80s — both within window

    const result = matchSessionByBirthTime(candidates, processStartMs, new Set());
    expect(result).toBe("session-close");
  });

  test("skips already-claimed IDs", () => {
    const candidates: SessionCandidate[] = [
      { id: "session-a", birthtimeMs: now - 5_000 },
      { id: "session-b", birthtimeMs: now - 8_000 },
    ];
    const processStartMs = now - 6_000;
    const claimed = new Set(["session-a"]); // session-a already claimed

    const result = matchSessionByBirthTime(candidates, processStartMs, claimed);
    expect(result).toBe("session-b");
  });

  test("returns undefined when all candidates are claimed", () => {
    const candidates: SessionCandidate[] = [{ id: "session-a", birthtimeMs: now - 5_000 }];
    const processStartMs = now - 6_000;
    const claimed = new Set(["session-a"]);

    const result = matchSessionByBirthTime(candidates, processStartMs, claimed);
    expect(result).toBeUndefined();
  });

  test("returns undefined for empty candidates", () => {
    const result = matchSessionByBirthTime([], now, new Set());
    expect(result).toBeUndefined();
  });

  test("zombie process (started 24h ago) does not match today's JSONL", () => {
    const candidates: SessionCandidate[] = [
      { id: "todays-session", birthtimeMs: now - 3600_000 }, // created 1h ago
    ];
    const processStartMs = now - 86400_000; // process started 24h ago
    // JSONL was created 23h AFTER the process started → no match

    const result = matchSessionByBirthTime(candidates, processStartMs, new Set());
    expect(result).toBeUndefined();
  });

  test("extracts session ID from --resume args", () => {
    const fullArgs =
      "/home/user/.local/bin/claude --resume 550e8400-e29b-41d4-a716-446655440000 --model claude-opus-4-6";
    expect(extractSessionIdFromArgs(fullArgs)).toBe("550e8400-e29b-41d4-a716-446655440000");
  });

  test("returns undefined when no --resume in args", () => {
    expect(extractSessionIdFromArgs("claude")).toBeUndefined();
    expect(extractSessionIdFromArgs("/usr/bin/claude")).toBeUndefined();
  });

  test("extracts session ID when --resume is the only flag", () => {
    expect(extractSessionIdFromArgs("claude --resume abcdef01-2345-6789-abcd-ef0123456789")).toBe(
      "abcdef01-2345-6789-abcd-ef0123456789",
    );
  });

  test("two processes in same dir each match their own JSONL", () => {
    const candidates: SessionCandidate[] = [
      { id: "session-early", birthtimeMs: now - 7200_000 }, // created 2h ago
      { id: "session-late", birthtimeMs: now - 60_000 }, // created 1min ago
    ];
    const claimed = new Set<string>();

    // Newer process matches newer JSONL
    const processB = now - 55_000; // started 55s ago
    const matchB = matchSessionByBirthTime(candidates, processB, claimed);
    expect(matchB).toBe("session-late"); // diff=5s
    if (matchB) claimed.add(matchB);

    // Older process matches older JSONL
    const processA = now - 7190_000; // started ~2h ago
    const matchA = matchSessionByBirthTime(candidates, processA, claimed);
    expect(matchA).toBe("session-early"); // diff=10s, session-late is claimed
  });
});
