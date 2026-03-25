import { describe, expect, test } from "bun:test";
import { extractClaudeSessionIdFromArgs, matchSessionByBirthTime, type SessionCandidate } from "./process-mapper";

// NOTE: findSessionCandidates is not tested here because it performs real file
// I/O (readdir, stat, Bun.spawn) against the user's Claude projects directory.
// Testing it properly would require either mocking the filesystem or creating
// temporary fixture directories. A future integration test could cover it.

describe("extractClaudeSessionIdFromArgs", () => {
  test("extracts UUID from --resume flag with full path binary", () => {
    const args = "/home/user/.local/bin/claude --resume 550e8400-e29b-41d4-a716-446655440000";
    expect(extractClaudeSessionIdFromArgs(args)).toBe("550e8400-e29b-41d4-a716-446655440000");
  });

  test("extracts UUID when --resume is the only flag", () => {
    const args = "claude --resume abcdef01-2345-6789-abcd-ef0123456789";
    expect(extractClaudeSessionIdFromArgs(args)).toBe("abcdef01-2345-6789-abcd-ef0123456789");
  });

  test("extracts UUID when --resume appears with other flags before it", () => {
    const args = "claude --model claude-opus-4-6 --resume 11111111-2222-3333-4444-555555555555";
    expect(extractClaudeSessionIdFromArgs(args)).toBe("11111111-2222-3333-4444-555555555555");
  });

  test("extracts UUID when --resume has flags after it", () => {
    const args = "claude --resume 550e8400-e29b-41d4-a716-446655440000 --model claude-opus-4-6";
    expect(extractClaudeSessionIdFromArgs(args)).toBe("550e8400-e29b-41d4-a716-446655440000");
  });

  test("extracts UUID with multiple spaces between --resume and UUID", () => {
    const args = "claude --resume   550e8400-e29b-41d4-a716-446655440000";
    expect(extractClaudeSessionIdFromArgs(args)).toBe("550e8400-e29b-41d4-a716-446655440000");
  });

  test("returns undefined when no --resume flag is present", () => {
    expect(extractClaudeSessionIdFromArgs("claude")).toBeUndefined();
  });

  test("returns undefined for bare binary path without flags", () => {
    expect(extractClaudeSessionIdFromArgs("/usr/bin/claude")).toBeUndefined();
  });

  test("returns undefined when --resume is followed by a non-UUID value", () => {
    expect(extractClaudeSessionIdFromArgs("claude --resume not-a-uuid")).toBeUndefined();
  });

  test("returns undefined when --resume has a truncated UUID (too short)", () => {
    expect(extractClaudeSessionIdFromArgs("claude --resume 550e8400-e29b-41d4")).toBeUndefined();
  });

  test("returns undefined when --resume value contains uppercase hex", () => {
    // The regex only matches lowercase hex [0-9a-f]
    expect(extractClaudeSessionIdFromArgs("claude --resume 550E8400-E29B-41D4-A716-446655440000")).toBeUndefined();
  });

  test("returns undefined for empty string args", () => {
    expect(extractClaudeSessionIdFromArgs("")).toBeUndefined();
  });

  test("returns undefined when --resume appears without a value", () => {
    expect(extractClaudeSessionIdFromArgs("claude --resume")).toBeUndefined();
  });

  test("does not match -resume (single dash)", () => {
    expect(extractClaudeSessionIdFromArgs("claude -resume 550e8400-e29b-41d4-a716-446655440000")).toBeUndefined();
  });

  test("extracts only the first UUID when --resume appears multiple times", () => {
    const args = "claude --resume aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee --resume 11111111-2222-3333-4444-555555555555";
    expect(extractClaudeSessionIdFromArgs(args)).toBe("aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee");
  });
});

describe("matchSessionByBirthTime", () => {
  const now = Date.now();
  const BIRTHTIME_MATCH_WINDOW_MS = 120_000; // 2 minutes, must match the constant in the source

  test("matches a session created close to the process start time", () => {
    const candidates: SessionCandidate[] = [
      { id: "session-new", birthtimeMs: now - 5_000 },
      { id: "session-old", birthtimeMs: now - 3_600_000 },
    ];
    const processStartMs = now - 10_000;

    const result = matchSessionByBirthTime(candidates, processStartMs, new Set());
    expect(result).toBe("session-new");
  });

  test("returns undefined when no candidates are within the time window", () => {
    const candidates: SessionCandidate[] = [{ id: "session-old", birthtimeMs: now - 3_600_000 }];
    const processStartMs = now - 60_000;

    const result = matchSessionByBirthTime(candidates, processStartMs, new Set());
    expect(result).toBeUndefined();
  });

  test("picks the candidate with the smallest time difference", () => {
    const candidates: SessionCandidate[] = [
      { id: "session-close", birthtimeMs: now - 8_000 },
      { id: "session-far", birthtimeMs: now - 90_000 },
    ];
    const processStartMs = now - 10_000;
    // session-close: diff=2s, session-far: diff=80s — both within 2min window

    const result = matchSessionByBirthTime(candidates, processStartMs, new Set());
    expect(result).toBe("session-close");
  });

  test("skips candidates whose IDs are in the claimed set", () => {
    const candidates: SessionCandidate[] = [
      { id: "session-a", birthtimeMs: now - 5_000 },
      { id: "session-b", birthtimeMs: now - 8_000 },
    ];
    const processStartMs = now - 6_000;
    const claimed = new Set(["session-a"]);

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

  test("returns undefined for an empty candidates array", () => {
    const result = matchSessionByBirthTime([], now, new Set());
    expect(result).toBeUndefined();
  });

  test("does not match when process started far before the session was created", () => {
    // Process started 24h ago, but the JSONL was created 1h ago
    const candidates: SessionCandidate[] = [{ id: "todays-session", birthtimeMs: now - 3_600_000 }];
    const processStartMs = now - 86_400_000;

    const result = matchSessionByBirthTime(candidates, processStartMs, new Set());
    expect(result).toBeUndefined();
  });

  test("does not match when session was created far before the process started", () => {
    // JSONL created 1h ago, process started just now
    const candidates: SessionCandidate[] = [{ id: "old-session", birthtimeMs: now - 3_600_000 }];
    const processStartMs = now;

    const result = matchSessionByBirthTime(candidates, processStartMs, new Set());
    expect(result).toBeUndefined();
  });

  test("matches at exactly the boundary of the time window", () => {
    // diff = BIRTHTIME_MATCH_WINDOW_MS - 1 (just inside the window)
    const candidates: SessionCandidate[] = [
      {
        id: "boundary-session",
        birthtimeMs: now - (BIRTHTIME_MATCH_WINDOW_MS - 1),
      },
    ];
    const processStartMs = now;

    const result = matchSessionByBirthTime(candidates, processStartMs, new Set());
    expect(result).toBe("boundary-session");
  });

  test("does not match at exactly the boundary of the time window (equal)", () => {
    // diff = BIRTHTIME_MATCH_WINDOW_MS exactly — uses strict < so should NOT match
    const candidates: SessionCandidate[] = [
      {
        id: "boundary-session",
        birthtimeMs: now - BIRTHTIME_MATCH_WINDOW_MS,
      },
    ];
    const processStartMs = now;

    const result = matchSessionByBirthTime(candidates, processStartMs, new Set());
    expect(result).toBeUndefined();
  });

  test("matches when birth time is slightly after process start (session created after process)", () => {
    // Process started 10s ago, session created 5s ago — diff = 5s
    const candidates: SessionCandidate[] = [{ id: "after-session", birthtimeMs: now - 5_000 }];
    const processStartMs = now - 10_000;

    const result = matchSessionByBirthTime(candidates, processStartMs, new Set());
    expect(result).toBe("after-session");
  });

  test("matches when birth time equals process start time exactly", () => {
    const candidates: SessionCandidate[] = [{ id: "exact-session", birthtimeMs: now }];
    const processStartMs = now;

    const result = matchSessionByBirthTime(candidates, processStartMs, new Set());
    expect(result).toBe("exact-session");
  });

  test("simulates two processes each matching their own session", () => {
    const candidates: SessionCandidate[] = [
      { id: "session-early", birthtimeMs: now - 7_200_000 },
      { id: "session-late", birthtimeMs: now - 60_000 },
    ];
    const claimed = new Set<string>();

    // Newer process matches newer session
    const processB = now - 55_000;
    const matchB = matchSessionByBirthTime(candidates, processB, claimed);
    expect(matchB).toBe("session-late");
    if (matchB) claimed.add(matchB);

    // Older process matches older session (session-late is now claimed)
    const processA = now - 7_190_000;
    const matchA = matchSessionByBirthTime(candidates, processA, claimed);
    expect(matchA).toBe("session-early");
  });

  test("handles single candidate that is claimed", () => {
    const candidates: SessionCandidate[] = [{ id: "only-one", birthtimeMs: now }];
    const result = matchSessionByBirthTime(candidates, now, new Set(["only-one"]));
    expect(result).toBeUndefined();
  });

  test("handles many candidates and picks the closest unclaimed one", () => {
    const candidates: SessionCandidate[] = [
      { id: "s1", birthtimeMs: now - 1_000 },
      { id: "s2", birthtimeMs: now - 2_000 },
      { id: "s3", birthtimeMs: now - 3_000 },
      { id: "s4", birthtimeMs: now - 50_000 },
      { id: "s5", birthtimeMs: now - 100_000 },
    ];
    const processStartMs = now - 2_500;
    // s1: diff=1500, s2: diff=500, s3: diff=500, s4: diff=47500, s5: diff=97500
    // s2 has diff=500, s3 has diff=500 — s2 appears first and will be set as best first
    const claimed = new Set(["s2"]);

    const result = matchSessionByBirthTime(candidates, processStartMs, claimed);
    expect(result).toBe("s3");
  });

  test("does not match candidates with birthtimeMs of 0", () => {
    // When birthtimeMs is 0 (unavailable on some filesystems), the diff from any
    // real process start time will far exceed BIRTHTIME_MATCH_WINDOW_MS
    const candidates: SessionCandidate[] = [{ id: "no-birthtime", birthtimeMs: 0 }];
    const processStartMs = now - 5_000;

    const result = matchSessionByBirthTime(candidates, processStartMs, new Set());
    expect(result).toBeUndefined();
  });

  test("skips candidates with birthtimeMs of 0 and matches valid ones", () => {
    const candidates: SessionCandidate[] = [
      { id: "zero-birthtime", birthtimeMs: 0 },
      { id: "valid-session", birthtimeMs: now - 5_000 },
    ];
    const processStartMs = now - 6_000;

    const result = matchSessionByBirthTime(candidates, processStartMs, new Set());
    expect(result).toBe("valid-session");
  });

  test("returns undefined when all candidates have birthtimeMs of 0", () => {
    const candidates: SessionCandidate[] = [
      { id: "zero-a", birthtimeMs: 0 },
      { id: "zero-b", birthtimeMs: 0 },
    ];
    const processStartMs = now - 10_000;

    const result = matchSessionByBirthTime(candidates, processStartMs, new Set());
    expect(result).toBeUndefined();
  });
});
