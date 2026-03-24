import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtemp, stat } from "node:fs/promises";
import * as fsPromises from "node:fs/promises";

import type { GeminiSessionFile } from "./session-discovery";

// We need to mock the file system paths. Since the module uses hardcoded paths,
// we'll test via the exported cache utilities and by mocking at the fs level.

// ---------------------------------------------------------------------------
// Factory helpers
// ---------------------------------------------------------------------------

function makeGeminiSessionFile(overrides: Partial<GeminiSessionFile> = {}): GeminiSessionFile {
	return {
		sessionId: "550e8400-e29b-41d4-a716-446655440000",
		projectHash: "abc123",
		startTime: "2026-03-20T10:00:00.000Z",
		lastUpdated: new Date().toISOString(),
		messages: [
			{
				id: "msg-1",
				timestamp: new Date().toISOString(),
				type: "user",
				content: [{ text: "Hello, Gemini!" }],
			},
			{
				id: "msg-2",
				timestamp: new Date().toISOString(),
				type: "gemini",
				content: "I will help you with that.",
				model: "gemini-2.5-pro",
				tokens: {
					input: 100,
					output: 50,
					cached: 0,
					thoughts: 0,
					tool: 0,
					total: 150,
				},
			},
		],
		...overrides,
	};
}

// ---------------------------------------------------------------------------
// Session cache tests
// ---------------------------------------------------------------------------

describe("Gemini session cache", () => {
	// Import dynamically to allow clearing the module cache if needed
	let clearGeminiSessionCache: () => void;
	let getGeminiSessionCacheSize: () => number;
	let getCachedGeminiSession: (filePath: string) => { mtimeMs: number; session: unknown } | undefined;
	let setCachedGeminiSession: (
		filePath: string,
		entry: { mtimeMs: number; session: unknown },
	) => void;

	beforeEach(async () => {
		const mod = await import("./session-discovery");
		clearGeminiSessionCache = mod.clearGeminiSessionCache;
		getGeminiSessionCacheSize = mod.getGeminiSessionCacheSize;
		getCachedGeminiSession = mod.getCachedGeminiSession;
		setCachedGeminiSession = mod.setCachedGeminiSession;
		clearGeminiSessionCache();
	});

	afterEach(() => {
		clearGeminiSessionCache();
	});

	test("cache starts empty", () => {
		expect(getGeminiSessionCacheSize()).toBe(0);
	});

	test("setCachedGeminiSession stores an entry and getCachedGeminiSession retrieves it", () => {
		const session = { sessionId: "test-123", agentType: "gemini-cli" as const };
		setCachedGeminiSession("/tmp/test.json", { mtimeMs: 1000, session });

		expect(getGeminiSessionCacheSize()).toBe(1);

		const cached = getCachedGeminiSession("/tmp/test.json");
		expect(cached).toBeDefined();
		expect(cached?.mtimeMs).toBe(1000);
		expect(cached?.session).toEqual(session);
	});

	test("getCachedGeminiSession returns undefined for missing entries", () => {
		const cached = getCachedGeminiSession("/tmp/nonexistent.json");
		expect(cached).toBeUndefined();
	});

	test("clearGeminiSessionCache removes all entries", () => {
		setCachedGeminiSession("/tmp/a.json", { mtimeMs: 1000, session: {} });
		setCachedGeminiSession("/tmp/b.json", { mtimeMs: 2000, session: {} });
		expect(getGeminiSessionCacheSize()).toBe(2);

		clearGeminiSessionCache();
		expect(getGeminiSessionCacheSize()).toBe(0);
	});

	test("setCachedGeminiSession overwrites existing entry with same key", () => {
		const session1 = { sessionId: "old" };
		const session2 = { sessionId: "new" };

		setCachedGeminiSession("/tmp/test.json", { mtimeMs: 1000, session: session1 });
		setCachedGeminiSession("/tmp/test.json", { mtimeMs: 2000, session: session2 });

		expect(getGeminiSessionCacheSize()).toBe(1);
		const cached = getCachedGeminiSession("/tmp/test.json");
		expect(cached?.mtimeMs).toBe(2000);
		expect(cached?.session).toEqual(session2);
	});
});
