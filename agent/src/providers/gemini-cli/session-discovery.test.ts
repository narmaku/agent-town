import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { SessionInfo } from "@agent-town/shared";
import { SESSION_RETENTION_MS } from "@agent-town/shared";

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
});
