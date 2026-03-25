import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { SessionInfo } from "@agent-town/shared";

import {
  clearGeminiSessionCache,
  getCachedGeminiSession,
  getGeminiSessionCacheSize,
  pruneGeminiSessionCache,
  setCachedGeminiSession,
} from "./session-discovery";

// ---------------------------------------------------------------------------
// Factory helpers
// ---------------------------------------------------------------------------

function makeSessionInfo(overrides: Partial<SessionInfo> = {}): SessionInfo {
  return {
    sessionId: "550e8400-e29b-41d4-a716-446655440000",
    agentType: "gemini-cli",
    slug: "550e8400",
    projectPath: "/home/user/project",
    projectName: "project",
    gitBranch: "",
    status: "idle",
    lastActivity: new Date().toISOString(),
    lastMessage: "Hello from Gemini",
    cwd: "/home/user/project",
    model: "gemini-2.5-pro",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Session cache data structure tests
// ---------------------------------------------------------------------------

describe("Gemini session cache", () => {
  beforeEach(() => {
    clearGeminiSessionCache();
  });

  afterEach(() => {
    clearGeminiSessionCache();
  });

  test("cache starts empty", () => {
    expect(getGeminiSessionCacheSize()).toBe(0);
  });

  test("setCachedGeminiSession stores an entry and getCachedGeminiSession retrieves it", () => {
    const session = makeSessionInfo({ sessionId: "test-123" });
    setCachedGeminiSession("/tmp/test.json", { mtimeMs: 1000, session });

    expect(getGeminiSessionCacheSize()).toBe(1);

    const cached = getCachedGeminiSession("/tmp/test.json");
    expect(cached).toBeDefined();
    expect(cached?.mtimeMs).toBe(1000);
    expect(cached?.session.sessionId).toBe("test-123");
  });

  test("getCachedGeminiSession returns undefined for missing entries", () => {
    const cached = getCachedGeminiSession("/tmp/nonexistent.json");
    expect(cached).toBeUndefined();
  });

  test("clearGeminiSessionCache removes all entries", () => {
    setCachedGeminiSession("/tmp/a.json", { mtimeMs: 1000, session: makeSessionInfo() });
    setCachedGeminiSession("/tmp/b.json", { mtimeMs: 2000, session: makeSessionInfo() });
    expect(getGeminiSessionCacheSize()).toBe(2);

    clearGeminiSessionCache();
    expect(getGeminiSessionCacheSize()).toBe(0);
  });

  test("setCachedGeminiSession overwrites existing entry with same key", () => {
    const session1 = makeSessionInfo({ sessionId: "old" });
    const session2 = makeSessionInfo({ sessionId: "new" });

    setCachedGeminiSession("/tmp/test.json", { mtimeMs: 1000, session: session1 });
    setCachedGeminiSession("/tmp/test.json", { mtimeMs: 2000, session: session2 });

    expect(getGeminiSessionCacheSize()).toBe(1);
    const cached = getCachedGeminiSession("/tmp/test.json");
    expect(cached?.mtimeMs).toBe(2000);
    expect(cached?.session.sessionId).toBe("new");
  });
});

// ---------------------------------------------------------------------------
// Cache pruning tests
// ---------------------------------------------------------------------------

describe("pruneGeminiSessionCache", () => {
  beforeEach(() => {
    clearGeminiSessionCache();
  });

  afterEach(() => {
    clearGeminiSessionCache();
  });

  test("removes cache entries whose file paths are not in the active set", () => {
    setCachedGeminiSession("/chats/a.json", { mtimeMs: 1000, session: makeSessionInfo({ sessionId: "a" }) });
    setCachedGeminiSession("/chats/b.json", { mtimeMs: 2000, session: makeSessionInfo({ sessionId: "b" }) });
    setCachedGeminiSession("/chats/c.json", { mtimeMs: 3000, session: makeSessionInfo({ sessionId: "c" }) });

    // Only a.json and c.json are still active (b.json was deleted)
    const activeFiles = new Set(["/chats/a.json", "/chats/c.json"]);
    pruneGeminiSessionCache(activeFiles);

    expect(getGeminiSessionCacheSize()).toBe(2);
    expect(getCachedGeminiSession("/chats/a.json")).toBeDefined();
    expect(getCachedGeminiSession("/chats/b.json")).toBeUndefined();
    expect(getCachedGeminiSession("/chats/c.json")).toBeDefined();
  });

  test("removes all entries when active set is empty", () => {
    setCachedGeminiSession("/chats/a.json", { mtimeMs: 1000, session: makeSessionInfo() });
    setCachedGeminiSession("/chats/b.json", { mtimeMs: 2000, session: makeSessionInfo() });

    pruneGeminiSessionCache(new Set());

    expect(getGeminiSessionCacheSize()).toBe(0);
  });

  test("keeps all entries when all are in the active set", () => {
    setCachedGeminiSession("/chats/a.json", { mtimeMs: 1000, session: makeSessionInfo() });
    setCachedGeminiSession("/chats/b.json", { mtimeMs: 2000, session: makeSessionInfo() });

    pruneGeminiSessionCache(new Set(["/chats/a.json", "/chats/b.json"]));

    expect(getGeminiSessionCacheSize()).toBe(2);
  });

  test("handles empty cache gracefully", () => {
    pruneGeminiSessionCache(new Set(["/chats/a.json"]));
    expect(getGeminiSessionCacheSize()).toBe(0);
  });

  test("ignores active set keys that do not exist in the cache", () => {
    setCachedGeminiSession("/chats/a.json", { mtimeMs: 1000, session: makeSessionInfo({ sessionId: "a" }) });

    // Active set has keys not in cache — should not crash or add entries
    pruneGeminiSessionCache(new Set(["/chats/a.json", "/chats/x.json", "/chats/y.json"]));

    expect(getGeminiSessionCacheSize()).toBe(1);
    expect(getCachedGeminiSession("/chats/a.json")).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Cache hit status recomputation tests
// ---------------------------------------------------------------------------

describe("Gemini session cache status recomputation", () => {
  // The discoverGeminiSessions cache hit path recomputes status from
  // lastActivity using detectGeminiStatus. Since detectGeminiStatus is not
  // exported, we verify the pattern used in the source: the cached session
  // object is the same reference stored in the cache, so mutating
  // cached.session.status also updates the map entry.

  beforeEach(() => {
    clearGeminiSessionCache();
  });

  afterEach(() => {
    clearGeminiSessionCache();
  });

  test("cached session status field is mutable via the returned reference", () => {
    const session = makeSessionInfo({ status: "working" });
    setCachedGeminiSession("/chats/a.json", { mtimeMs: 1000, session });

    const cached = getCachedGeminiSession("/chats/a.json");
    expect(cached).toBeDefined();
    expect(cached?.session.status).toBe("working");

    // Simulate what discoverGeminiSessions does on cache hit: mutate the status
    // (the source code uses non-optional access after a truthy check)
    if (cached) {
      cached.session.status = "done";
    }

    // The mutation is visible through a fresh get because Map stores a reference
    const refetched = getCachedGeminiSession("/chats/a.json");
    expect(refetched?.session.status).toBe("done");
  });

  test("cached session with very recent lastActivity would map to working status", () => {
    // lastActivity = 5 seconds ago  =>  age < 30s  =>  "working"
    const recentTime = new Date(Date.now() - 5_000).toISOString();
    const session = makeSessionInfo({ status: "idle", lastActivity: recentTime });
    setCachedGeminiSession("/chats/a.json", { mtimeMs: 1000, session });

    const cached = getCachedGeminiSession("/chats/a.json");
    expect(cached).toBeDefined();

    // Replicate the cache hit status recomputation logic from discoverGeminiSessions
    const lastUpdatedMs = new Date(cached?.session.lastActivity).getTime();
    const age = Date.now() - lastUpdatedMs;
    expect(age).toBeLessThan(30_000);

    // Verify the lastActivity timestamp parses correctly
    expect(Number.isNaN(lastUpdatedMs)).toBe(false);
  });

  test("cached session with old lastActivity would map to idle status (never done)", () => {
    // lastActivity = 15 minutes ago  =>  age > 60s  =>  "idle" (done is hook-only)
    const oldTime = new Date(Date.now() - 15 * 60 * 1000).toISOString();
    const session = makeSessionInfo({ status: "working", lastActivity: oldTime });
    setCachedGeminiSession("/chats/a.json", { mtimeMs: 1000, session });

    const cached = getCachedGeminiSession("/chats/a.json");
    expect(cached).toBeDefined();

    const lastUpdatedMs = new Date(cached?.session.lastActivity).getTime();
    const age = Date.now() - lastUpdatedMs;
    expect(age).toBeGreaterThan(60_000);

    // Verify the lastActivity timestamp parses correctly
    expect(Number.isNaN(lastUpdatedMs)).toBe(false);
  });

  test("cached session preserves all SessionInfo fields across get/set", () => {
    const session = makeSessionInfo({
      sessionId: "preserve-test",
      agentType: "gemini-cli",
      slug: "preserve",
      projectPath: "/home/user/my-project",
      projectName: "my-project",
      gitBranch: "feature/test",
      status: "working",
      lastActivity: "2026-03-24T10:00:00.000Z",
      lastMessage: "Test message content",
      cwd: "/home/user/my-project/src",
      model: "gemini-2.5-flash",
      totalInputTokens: 5000,
      totalOutputTokens: 2000,
      contextTokens: 7000,
    });

    setCachedGeminiSession("/chats/preserve.json", { mtimeMs: 99999, session });

    const cached = getCachedGeminiSession("/chats/preserve.json");
    expect(cached).toBeDefined();
    expect(cached?.mtimeMs).toBe(99999);
    expect(cached?.session.sessionId).toBe("preserve-test");
    expect(cached?.session.agentType).toBe("gemini-cli");
    expect(cached?.session.slug).toBe("preserve");
    expect(cached?.session.projectPath).toBe("/home/user/my-project");
    expect(cached?.session.projectName).toBe("my-project");
    expect(cached?.session.gitBranch).toBe("feature/test");
    expect(cached?.session.status).toBe("working");
    expect(cached?.session.lastActivity).toBe("2026-03-24T10:00:00.000Z");
    expect(cached?.session.lastMessage).toBe("Test message content");
    expect(cached?.session.cwd).toBe("/home/user/my-project/src");
    expect(cached?.session.model).toBe("gemini-2.5-flash");
    expect(cached?.session.totalInputTokens).toBe(5000);
    expect(cached?.session.totalOutputTokens).toBe(2000);
    expect(cached?.session.contextTokens).toBe(7000);
  });

  test("cache entry with updated mtime replaces the old session data", () => {
    const oldSession = makeSessionInfo({ sessionId: "old-parse", lastMessage: "old message" });
    const newSession = makeSessionInfo({ sessionId: "new-parse", lastMessage: "new message" });

    // Simulate initial cache population
    setCachedGeminiSession("/chats/session.json", { mtimeMs: 1000, session: oldSession });

    // Simulate mtime change: cache miss triggers re-parse and overwrites
    setCachedGeminiSession("/chats/session.json", { mtimeMs: 2000, session: newSession });

    const cached = getCachedGeminiSession("/chats/session.json");
    expect(cached?.mtimeMs).toBe(2000);
    expect(cached?.session.sessionId).toBe("new-parse");
    expect(cached?.session.lastMessage).toBe("new message");
  });

  test("cache hit check: same mtime means cache hit, different mtime means miss", () => {
    const session = makeSessionInfo({ sessionId: "mtime-test" });
    setCachedGeminiSession("/chats/mtime.json", { mtimeMs: 5000, session });

    const cached = getCachedGeminiSession("/chats/mtime.json");
    expect(cached).toBeDefined();

    // Same mtime => cache hit
    const fileMtime = 5000;
    expect(cached?.mtimeMs === fileMtime).toBe(true);

    // Different mtime => cache miss
    const newFileMtime = 6000;
    expect(cached?.mtimeMs === newFileMtime).toBe(false);
  });
});
