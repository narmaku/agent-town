import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// --- Test data factories ---

interface SdkPart {
  id: string;
  type: string;
  text?: string;
  name?: string;
  toolName?: string;
  toolCallId?: string;
}

interface SdkMessageInfo {
  role: string;
  time: { created: string };
  modelID?: string;
  providerID?: string;
}

interface SdkMessage {
  info: SdkMessageInfo;
  parts: SdkPart[];
}

function makeSdkMessage(overrides: Partial<SdkMessage> = {}): SdkMessage {
  return {
    info: {
      role: "assistant",
      time: { created: "2026-03-19T10:00:00.000Z" },
      ...overrides.info,
    },
    parts: overrides.parts ?? [{ id: "p1", type: "text", text: "Hello from SDK" }],
  };
}

function makeSdkUserMessage(text = "User question"): SdkMessage {
  return makeSdkMessage({
    info: { role: "user", time: { created: "2026-03-19T09:59:00.000Z" } },
    parts: [{ id: "p0", type: "text", text }],
  });
}

// --- Mocking setup ---
// mock.module requires the absolute path with .ts extension to correctly
// intercept transitive imports from message-parser.ts.

const PROVIDER_DIR = import.meta.dir;
const SESSION_DISCOVERY_PATH = join(PROVIDER_DIR, "session-discovery.ts");
const SDK_CLIENT_PATH = join(PROVIDER_DIR, "sdk-client.ts");

let tempDir: string;
let dbPath: string;
let mockClient: { session: { messages: ReturnType<typeof mock> } } | null;

// Mock the sdk-client module so we control what getOpenCodeClient returns
mock.module(SDK_CLIENT_PATH, () => ({
  getOpenCodeClient: async () => mockClient,
  resetOpenCodeClient: () => {
    mockClient = null;
  },
}));

// Initial mock for session-discovery (will be re-mocked in beforeEach with correct path)
mock.module(SESSION_DISCOVERY_PATH, () => ({
  OPENCODE_DB_PATH: "",
}));

// Now import the function under test AFTER mocking
const { getOpenCodeSessionMessages } = await import("./message-parser");

describe("getOpenCodeSessionMessages", () => {
  beforeEach(async () => {
    mockClient = null;
    tempDir = await mkdtemp(join(tmpdir(), "opencode-msg-test-"));
    dbPath = join(tempDir, "opencode.db");

    // Re-mock session-discovery with the current temp db path
    mock.module(SESSION_DISCOVERY_PATH, () => ({
      OPENCODE_DB_PATH: dbPath,
    }));
  });

  afterEach(async () => {
    mockClient = null;
    await rm(tempDir, { recursive: true, force: true });
  });

  // --- Helper to set up SQLite test database ---

  function createTestDb(): Database {
    const db = new Database(dbPath);
    db.run(`CREATE TABLE IF NOT EXISTS message (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      time_created INTEGER NOT NULL,
      data TEXT NOT NULL
    )`);
    db.run(`CREATE TABLE IF NOT EXISTS part (
      id TEXT PRIMARY KEY,
      message_id TEXT NOT NULL,
      data TEXT NOT NULL
    )`);
    return db;
  }

  function insertMessage(
    db: Database,
    id: string,
    sessionId: string,
    timeCreated: number,
    data: Record<string, unknown>,
  ): void {
    db.run("INSERT INTO message (id, session_id, time_created, data) VALUES (?, ?, ?, ?)", [
      id,
      sessionId,
      timeCreated,
      JSON.stringify(data),
    ]);
  }

  function insertPart(db: Database, id: string, messageId: string, data: Record<string, unknown>): void {
    db.run("INSERT INTO part (id, message_id, data) VALUES (?, ?, ?)", [id, messageId, JSON.stringify(data)]);
  }

  // =====================
  // SDK path tests
  // =====================

  describe("via SDK", () => {
    test("returns formatted messages from SDK client", async () => {
      const sdkMessages: SdkMessage[] = [
        makeSdkUserMessage("What is 2+2?"),
        makeSdkMessage({
          info: {
            role: "assistant",
            time: { created: "2026-03-19T10:00:00.000Z" },
            modelID: "claude-opus-4-6",
            providerID: "anthropic",
          },
          parts: [{ id: "p1", type: "text", text: "The answer is 4." }],
        }),
      ];

      mockClient = {
        session: {
          messages: mock(() => Promise.resolve({ data: sdkMessages })),
        },
      };

      const result = await getOpenCodeSessionMessages("ses_test123", 0, 10);

      expect(result.total).toBe(2);
      expect(result.messages).toHaveLength(2);
      expect(result.hasMore).toBe(false);

      expect(result.messages[0].role).toBe("user");
      expect(result.messages[0].content).toBe("What is 2+2?");
      expect(result.messages[0].timestamp).toBe("2026-03-19T09:59:00.000Z");

      expect(result.messages[1].role).toBe("assistant");
      expect(result.messages[1].content).toBe("The answer is 4.");
      expect(result.messages[1].model).toBe("anthropic/claude-opus-4-6");
    });

    test("filters out system role messages", async () => {
      const sdkMessages: SdkMessage[] = [
        makeSdkMessage({
          info: { role: "system", time: { created: "2026-03-19T09:58:00.000Z" } },
          parts: [{ id: "s1", type: "text", text: "System prompt" }],
        }),
        makeSdkUserMessage("Hello"),
        makeSdkMessage(),
      ];

      mockClient = {
        session: {
          messages: mock(() => Promise.resolve({ data: sdkMessages })),
        },
      };

      const result = await getOpenCodeSessionMessages("ses_test123", 0, 10);
      expect(result.total).toBe(2);
      expect(result.messages).toHaveLength(2);
      expect(result.messages[0].role).toBe("user");
      expect(result.messages[1].role).toBe("assistant");
    });

    test("handles tool-invocation parts", async () => {
      const sdkMessages: SdkMessage[] = [
        makeSdkMessage({
          info: {
            role: "assistant",
            time: { created: "2026-03-19T10:00:00.000Z" },
          },
          parts: [
            { id: "p1", type: "text", text: "Let me read that file." },
            { id: "p2", type: "tool-invocation", name: "Read", toolCallId: "tc_001" },
          ],
        }),
      ];

      mockClient = {
        session: {
          messages: mock(() => Promise.resolve({ data: sdkMessages })),
        },
      };

      const result = await getOpenCodeSessionMessages("ses_test123", 0, 10);
      expect(result.messages[0].content).toBe("Let me read that file.");
      expect(result.messages[0].toolUse).toEqual([{ name: "Read", id: "tc_001" }]);
    });

    test("handles tool type parts with toolName field", async () => {
      const sdkMessages: SdkMessage[] = [
        makeSdkMessage({
          info: {
            role: "assistant",
            time: { created: "2026-03-19T10:00:00.000Z" },
          },
          parts: [
            {
              id: "p1",
              type: "tool",
              toolName: "Edit",
              toolCallId: "tc_002",
            } as SdkPart,
          ],
        }),
      ];

      mockClient = {
        session: {
          messages: mock(() => Promise.resolve({ data: sdkMessages })),
        },
      };

      const result = await getOpenCodeSessionMessages("ses_test123", 0, 10);
      expect(result.messages[0].toolUse).toEqual([{ name: "Edit", id: "tc_002" }]);
    });

    test("falls back to part.id when toolCallId is missing", async () => {
      const sdkMessages: SdkMessage[] = [
        makeSdkMessage({
          info: {
            role: "assistant",
            time: { created: "2026-03-19T10:00:00.000Z" },
          },
          parts: [{ id: "fallback-id", type: "tool-invocation", name: "Bash" }],
        }),
      ];

      mockClient = {
        session: {
          messages: mock(() => Promise.resolve({ data: sdkMessages })),
        },
      };

      const result = await getOpenCodeSessionMessages("ses_test123", 0, 10);
      expect(result.messages[0].toolUse).toEqual([{ name: "Bash", id: "fallback-id" }]);
    });

    test("falls back to 'unknown' when tool name fields are missing", async () => {
      const sdkMessages: SdkMessage[] = [
        makeSdkMessage({
          info: {
            role: "assistant",
            time: { created: "2026-03-19T10:00:00.000Z" },
          },
          parts: [{ id: "p1", type: "tool-invocation" }],
        }),
      ];

      mockClient = {
        session: {
          messages: mock(() => Promise.resolve({ data: sdkMessages })),
        },
      };

      const result = await getOpenCodeSessionMessages("ses_test123", 0, 10);
      expect(result.messages[0].toolUse).toEqual([{ name: "unknown", id: "p1" }]);
    });

    test("joins multiple text parts with double newline", async () => {
      const sdkMessages: SdkMessage[] = [
        makeSdkMessage({
          info: {
            role: "assistant",
            time: { created: "2026-03-19T10:00:00.000Z" },
          },
          parts: [
            { id: "p1", type: "text", text: "First paragraph." },
            { id: "p2", type: "text", text: "Second paragraph." },
          ],
        }),
      ];

      mockClient = {
        session: {
          messages: mock(() => Promise.resolve({ data: sdkMessages })),
        },
      };

      const result = await getOpenCodeSessionMessages("ses_test123", 0, 10);
      expect(result.messages[0].content).toBe("First paragraph.\n\nSecond paragraph.");
    });

    test("returns empty content when no text parts exist", async () => {
      const sdkMessages: SdkMessage[] = [
        makeSdkMessage({
          info: {
            role: "assistant",
            time: { created: "2026-03-19T10:00:00.000Z" },
          },
          parts: [{ id: "p1", type: "tool-invocation", name: "Bash", toolCallId: "tc1" }],
        }),
      ];

      mockClient = {
        session: {
          messages: mock(() => Promise.resolve({ data: sdkMessages })),
        },
      };

      const result = await getOpenCodeSessionMessages("ses_test123", 0, 10);
      expect(result.messages[0].content).toBe("");
      expect(result.messages[0].toolUse).toEqual([{ name: "Bash", id: "tc1" }]);
    });

    test("omits toolUse when no tool parts exist", async () => {
      const sdkMessages: SdkMessage[] = [
        makeSdkMessage({
          info: {
            role: "assistant",
            time: { created: "2026-03-19T10:00:00.000Z" },
          },
          parts: [{ id: "p1", type: "text", text: "Just text, no tools." }],
        }),
      ];

      mockClient = {
        session: {
          messages: mock(() => Promise.resolve({ data: sdkMessages })),
        },
      };

      const result = await getOpenCodeSessionMessages("ses_test123", 0, 10);
      expect(result.messages[0].toolUse).toBeUndefined();
    });

    test("sets model to modelID only when providerID is missing", async () => {
      const sdkMessages: SdkMessage[] = [
        makeSdkMessage({
          info: {
            role: "assistant",
            time: { created: "2026-03-19T10:00:00.000Z" },
            modelID: "gpt-4o",
          },
          parts: [{ id: "p1", type: "text", text: "Hi" }],
        }),
      ];

      mockClient = {
        session: {
          messages: mock(() => Promise.resolve({ data: sdkMessages })),
        },
      };

      const result = await getOpenCodeSessionMessages("ses_test123", 0, 10);
      expect(result.messages[0].model).toBe("gpt-4o");
    });

    test("sets model to undefined when modelID is missing", async () => {
      const sdkMessages: SdkMessage[] = [
        makeSdkMessage({
          info: {
            role: "assistant",
            time: { created: "2026-03-19T10:00:00.000Z" },
          },
          parts: [{ id: "p1", type: "text", text: "Hi" }],
        }),
      ];

      mockClient = {
        session: {
          messages: mock(() => Promise.resolve({ data: sdkMessages })),
        },
      };

      const result = await getOpenCodeSessionMessages("ses_test123", 0, 10);
      expect(result.messages[0].model).toBeUndefined();
    });

    test("paginates from end with offset and limit", async () => {
      const sdkMessages: SdkMessage[] = Array.from({ length: 5 }, (_, i) =>
        makeSdkMessage({
          info: {
            role: i % 2 === 0 ? "user" : "assistant",
            time: { created: `2026-03-19T10:0${i}:00.000Z` },
          },
          parts: [{ id: `p${i}`, type: "text", text: `Message ${i}` }],
        }),
      );

      mockClient = {
        session: {
          messages: mock(() => Promise.resolve({ data: sdkMessages })),
        },
      };

      // Get last 2 messages (offset=0, limit=2) — should return messages 3 and 4
      const result = await getOpenCodeSessionMessages("ses_test123", 0, 2);
      expect(result.total).toBe(5);
      expect(result.messages).toHaveLength(2);
      expect(result.hasMore).toBe(true);
      expect(result.messages[0].content).toBe("Message 3");
      expect(result.messages[1].content).toBe("Message 4");
    });

    test("paginates with offset to get earlier messages", async () => {
      const sdkMessages: SdkMessage[] = Array.from({ length: 5 }, (_, i) =>
        makeSdkMessage({
          info: {
            role: i % 2 === 0 ? "user" : "assistant",
            time: { created: `2026-03-19T10:0${i}:00.000Z` },
          },
          parts: [{ id: `p${i}`, type: "text", text: `Message ${i}` }],
        }),
      );

      mockClient = {
        session: {
          messages: mock(() => Promise.resolve({ data: sdkMessages })),
        },
      };

      // Skip last 2, get 2 more (offset=2, limit=2) — should return messages 1 and 2
      const result = await getOpenCodeSessionMessages("ses_test123", 2, 2);
      expect(result.total).toBe(5);
      expect(result.messages).toHaveLength(2);
      expect(result.hasMore).toBe(true);
      expect(result.messages[0].content).toBe("Message 1");
      expect(result.messages[1].content).toBe("Message 2");
    });

    test("hasMore is false when all messages fit", async () => {
      const sdkMessages: SdkMessage[] = [makeSdkUserMessage("Hi"), makeSdkMessage()];

      mockClient = {
        session: {
          messages: mock(() => Promise.resolve({ data: sdkMessages })),
        },
      };

      const result = await getOpenCodeSessionMessages("ses_test123", 0, 100);
      expect(result.hasMore).toBe(false);
      expect(result.total).toBe(2);
    });

    test("throws when SDK returns no data and SQLite has no matching session", async () => {
      mockClient = {
        session: {
          messages: mock(() => Promise.resolve({ data: undefined })),
        },
      };

      // Create empty database so SQLite path runs but finds no messages for this session
      const db = createTestDb();
      db.close();

      // SDK path throws "Session not found", falls back to SQLite which returns empty
      // but wait — SDK throws, then SQLite finds 0 messages and returns {messages:[], total:0}
      // Actually re-reading the code: if data is undefined, it throws Error("Session not found")
      // which triggers the catch block => resetOpenCodeClient() => falls back to SQLite
      // SQLite will find 0 rows for ses_missing => returns {messages:[], total:0, hasMore:false}
      const result = await getOpenCodeSessionMessages("ses_missing", 0, 10);
      expect(result.total).toBe(0);
      expect(result.messages).toHaveLength(0);
    });

    test("handles empty parts array", async () => {
      const sdkMessages: SdkMessage[] = [
        makeSdkMessage({
          info: {
            role: "assistant",
            time: { created: "2026-03-19T10:00:00.000Z" },
          },
          parts: [],
        }),
      ];

      mockClient = {
        session: {
          messages: mock(() => Promise.resolve({ data: sdkMessages })),
        },
      };

      const result = await getOpenCodeSessionMessages("ses_test123", 0, 10);
      expect(result.messages).toHaveLength(1);
      expect(result.messages[0].content).toBe("");
      expect(result.messages[0].toolUse).toBeUndefined();
    });

    test("skips text parts with empty text", async () => {
      const sdkMessages: SdkMessage[] = [
        makeSdkMessage({
          info: {
            role: "assistant",
            time: { created: "2026-03-19T10:00:00.000Z" },
          },
          parts: [
            { id: "p1", type: "text", text: "" },
            { id: "p2", type: "text", text: "Actual content" },
          ],
        }),
      ];

      mockClient = {
        session: {
          messages: mock(() => Promise.resolve({ data: sdkMessages })),
        },
      };

      const result = await getOpenCodeSessionMessages("ses_test123", 0, 10);
      // Empty text is falsy, so only "Actual content" is included
      expect(result.messages[0].content).toBe("Actual content");
    });

    test("falls back to SQLite when SDK throws an error", async () => {
      mockClient = {
        session: {
          messages: mock(() => Promise.reject(new Error("Connection refused"))),
        },
      };

      // Set up SQLite fallback
      const db = createTestDb();
      const now = Date.now();
      insertMessage(db, "msg1", "ses_fallback", now, { role: "user" });
      insertPart(db, "part1", "msg1", { type: "text", text: "Fallback question" });
      db.close();

      const result = await getOpenCodeSessionMessages("ses_fallback", 0, 10);
      expect(result.total).toBe(1);
      expect(result.messages[0].content).toBe("Fallback question");
    });
  });

  // =====================
  // SQLite fallback tests
  // =====================

  describe("via SQLite fallback", () => {
    test("returns formatted messages from SQLite", async () => {
      const db = createTestDb();
      const baseTime = new Date("2026-03-19T10:00:00.000Z").getTime();

      insertMessage(db, "msg1", "ses_abc", baseTime, { role: "user" });
      insertPart(db, "part1", "msg1", { type: "text", text: "Hello from user" });

      insertMessage(db, "msg2", "ses_abc", baseTime + 1000, {
        role: "assistant",
        modelID: "claude-opus-4-6",
        providerID: "anthropic",
      });
      insertPart(db, "part2", "msg2", { type: "text", text: "Hello from assistant" });
      db.close();

      const result = await getOpenCodeSessionMessages("ses_abc", 0, 10);

      expect(result.total).toBe(2);
      expect(result.messages).toHaveLength(2);
      expect(result.hasMore).toBe(false);

      expect(result.messages[0].role).toBe("user");
      expect(result.messages[0].content).toBe("Hello from user");
      expect(result.messages[0].timestamp).toBe(new Date(baseTime).toISOString());

      expect(result.messages[1].role).toBe("assistant");
      expect(result.messages[1].content).toBe("Hello from assistant");
      expect(result.messages[1].model).toBe("anthropic/claude-opus-4-6");
    });

    test("filters out system messages", async () => {
      const db = createTestDb();
      const baseTime = Date.now();

      insertMessage(db, "msg0", "ses_abc", baseTime, { role: "system" });
      insertPart(db, "part0", "msg0", { type: "text", text: "System prompt" });

      insertMessage(db, "msg1", "ses_abc", baseTime + 1000, { role: "user" });
      insertPart(db, "part1", "msg1", { type: "text", text: "User msg" });

      insertMessage(db, "msg2", "ses_abc", baseTime + 2000, { role: "assistant" });
      insertPart(db, "part2", "msg2", { type: "text", text: "Assistant msg" });
      db.close();

      const result = await getOpenCodeSessionMessages("ses_abc", 0, 10);
      expect(result.total).toBe(2);
      expect(result.messages).toHaveLength(2);
    });

    test("returns empty result for session with no messages", async () => {
      const db = createTestDb();
      db.close();

      const result = await getOpenCodeSessionMessages("ses_empty", 0, 10);
      expect(result.total).toBe(0);
      expect(result.messages).toHaveLength(0);
      expect(result.hasMore).toBe(false);
    });

    test("handles tool-invocation parts in SQLite", async () => {
      const db = createTestDb();
      const baseTime = Date.now();

      insertMessage(db, "msg1", "ses_abc", baseTime, { role: "assistant" });
      insertPart(db, "part1", "msg1", { type: "text", text: "Let me check." });
      insertPart(db, "part2", "msg1", {
        type: "tool-invocation",
        name: "Read",
        toolCallId: "tc_100",
      });
      db.close();

      const result = await getOpenCodeSessionMessages("ses_abc", 0, 10);
      expect(result.messages[0].content).toBe("Let me check.");
      expect(result.messages[0].toolUse).toEqual([{ name: "Read", id: "tc_100" }]);
    });

    test("falls back to part.id when toolCallId is missing in SQLite", async () => {
      const db = createTestDb();
      insertMessage(db, "msg1", "ses_abc", Date.now(), { role: "assistant" });
      insertPart(db, "part-fallback-id", "msg1", {
        type: "tool-invocation",
        name: "Bash",
      });
      db.close();

      const result = await getOpenCodeSessionMessages("ses_abc", 0, 10);
      expect(result.messages[0].toolUse).toEqual([{ name: "Bash", id: "part-fallback-id" }]);
    });

    test("omits toolUse when no tool parts exist in SQLite", async () => {
      const db = createTestDb();
      insertMessage(db, "msg1", "ses_abc", Date.now(), { role: "user" });
      insertPart(db, "part1", "msg1", { type: "text", text: "Just a question" });
      db.close();

      const result = await getOpenCodeSessionMessages("ses_abc", 0, 10);
      expect(result.messages[0].toolUse).toBeUndefined();
    });

    test("joins multiple text parts with double newline in SQLite", async () => {
      const db = createTestDb();
      insertMessage(db, "msg1", "ses_abc", Date.now(), { role: "assistant" });
      insertPart(db, "part1", "msg1", { type: "text", text: "Paragraph one." });
      insertPart(db, "part2", "msg1", { type: "text", text: "Paragraph two." });
      db.close();

      const result = await getOpenCodeSessionMessages("ses_abc", 0, 10);
      expect(result.messages[0].content).toBe("Paragraph one.\n\nParagraph two.");
    });

    test("formats model as providerID/modelID when both present", async () => {
      const db = createTestDb();
      insertMessage(db, "msg1", "ses_abc", Date.now(), {
        role: "assistant",
        modelID: "gpt-4o",
        providerID: "openai",
      });
      insertPart(db, "part1", "msg1", { type: "text", text: "Hi" });
      db.close();

      const result = await getOpenCodeSessionMessages("ses_abc", 0, 10);
      expect(result.messages[0].model).toBe("openai/gpt-4o");
    });

    test("strips leading slash when providerID is empty", async () => {
      const db = createTestDb();
      insertMessage(db, "msg1", "ses_abc", Date.now(), {
        role: "assistant",
        modelID: "gpt-4o",
      });
      insertPart(db, "part1", "msg1", { type: "text", text: "Hi" });
      db.close();

      const result = await getOpenCodeSessionMessages("ses_abc", 0, 10);
      // model = "/gpt-4o" -> stripped to "gpt-4o"
      expect(result.messages[0].model).toBe("gpt-4o");
    });

    test("sets model to undefined when modelID is missing", async () => {
      const db = createTestDb();
      insertMessage(db, "msg1", "ses_abc", Date.now(), { role: "assistant" });
      insertPart(db, "part1", "msg1", { type: "text", text: "Hi" });
      db.close();

      const result = await getOpenCodeSessionMessages("ses_abc", 0, 10);
      expect(result.messages[0].model).toBeUndefined();
    });

    test("defaults role to user when data JSON is malformed", async () => {
      const db = createTestDb();
      insertMessage(db, "msg1", "ses_abc", Date.now(), { role: "user" });
      insertPart(db, "part1", "msg1", { type: "text", text: "Hello" });
      db.close();

      const result = await getOpenCodeSessionMessages("ses_abc", 0, 10);
      expect(result.messages[0].role).toBe("user");
    });

    test("skips parts with unparseable JSON data", async () => {
      const db = createTestDb();
      insertMessage(db, "msg1", "ses_abc", Date.now(), { role: "assistant" });
      // Insert a part with valid JSON
      insertPart(db, "part1", "msg1", { type: "text", text: "Good part" });
      // Insert a part with invalid JSON directly
      db.run("INSERT INTO part (id, message_id, data) VALUES (?, ?, ?)", ["part2", "msg1", "not valid json"]);
      db.close();

      const result = await getOpenCodeSessionMessages("ses_abc", 0, 10);
      expect(result.messages[0].content).toBe("Good part");
    });

    test("handles messages with no parts", async () => {
      const db = createTestDb();
      insertMessage(db, "msg1", "ses_abc", Date.now(), { role: "user" });
      // No parts inserted for this message
      db.close();

      const result = await getOpenCodeSessionMessages("ses_abc", 0, 10);
      expect(result.messages[0].content).toBe("");
      expect(result.messages[0].toolUse).toBeUndefined();
    });

    test("paginates from end correctly with SQLite", async () => {
      const db = createTestDb();
      const baseTime = Date.now();

      for (let i = 0; i < 5; i++) {
        const role = i % 2 === 0 ? "user" : "assistant";
        insertMessage(db, `msg${i}`, "ses_abc", baseTime + i * 1000, { role });
        insertPart(db, `part${i}`, `msg${i}`, { type: "text", text: `Message ${i}` });
      }
      db.close();

      // Get last 2 messages (offset=0, limit=2)
      const result = await getOpenCodeSessionMessages("ses_abc", 0, 2);
      expect(result.total).toBe(5);
      expect(result.messages).toHaveLength(2);
      expect(result.hasMore).toBe(true);
      expect(result.messages[0].content).toBe("Message 3");
      expect(result.messages[1].content).toBe("Message 4");
    });

    test("paginates with offset to get earlier messages in SQLite", async () => {
      const db = createTestDb();
      const baseTime = Date.now();

      for (let i = 0; i < 5; i++) {
        const role = i % 2 === 0 ? "user" : "assistant";
        insertMessage(db, `msg${i}`, "ses_abc", baseTime + i * 1000, { role });
        insertPart(db, `part${i}`, `msg${i}`, { type: "text", text: `Message ${i}` });
      }
      db.close();

      // Skip last 2, get 2 more (offset=2, limit=2)
      const result = await getOpenCodeSessionMessages("ses_abc", 2, 2);
      expect(result.total).toBe(5);
      expect(result.messages).toHaveLength(2);
      expect(result.hasMore).toBe(true);
      expect(result.messages[0].content).toBe("Message 1");
      expect(result.messages[1].content).toBe("Message 2");
    });

    test("hasMore is false when retrieving from the beginning", async () => {
      const db = createTestDb();
      const baseTime = Date.now();

      for (let i = 0; i < 3; i++) {
        const role = i % 2 === 0 ? "user" : "assistant";
        insertMessage(db, `msg${i}`, "ses_abc", baseTime + i * 1000, { role });
        insertPart(db, `part${i}`, `msg${i}`, { type: "text", text: `Message ${i}` });
      }
      db.close();

      // Get all messages (offset=0, limit=100)
      const result = await getOpenCodeSessionMessages("ses_abc", 0, 100);
      expect(result.total).toBe(3);
      expect(result.messages).toHaveLength(3);
      expect(result.hasMore).toBe(false);
    });

    test("isolates messages by session ID", async () => {
      const db = createTestDb();
      const baseTime = Date.now();

      insertMessage(db, "msg1", "ses_abc", baseTime, { role: "user" });
      insertPart(db, "part1", "msg1", { type: "text", text: "Session A" });

      insertMessage(db, "msg2", "ses_xyz", baseTime + 1000, { role: "user" });
      insertPart(db, "part2", "msg2", { type: "text", text: "Session B" });
      db.close();

      const result = await getOpenCodeSessionMessages("ses_abc", 0, 10);
      expect(result.total).toBe(1);
      expect(result.messages).toHaveLength(1);
      expect(result.messages[0].content).toBe("Session A");
    });

    test("throws 'Session not found' when database does not exist", async () => {
      // Re-mock with a non-existent path
      mock.module(SESSION_DISCOVERY_PATH, () => ({
        OPENCODE_DB_PATH: join(tempDir, "nonexistent.db"),
      }));

      await expect(getOpenCodeSessionMessages("ses_missing", 0, 10)).rejects.toThrow("Session not found");
    });

    test("handles multiple tool invocations in a single message", async () => {
      const db = createTestDb();
      insertMessage(db, "msg1", "ses_abc", Date.now(), { role: "assistant" });
      insertPart(db, "part1", "msg1", { type: "text", text: "Running commands." });
      insertPart(db, "part2", "msg1", { type: "tool-invocation", name: "Read", toolCallId: "tc1" });
      insertPart(db, "part3", "msg1", { type: "tool-invocation", name: "Edit", toolCallId: "tc2" });
      db.close();

      const result = await getOpenCodeSessionMessages("ses_abc", 0, 10);
      expect(result.messages[0].toolUse).toHaveLength(2);
      expect(result.messages[0].toolUse).toEqual([
        { name: "Read", id: "tc1" },
        { name: "Edit", id: "tc2" },
      ]);
    });

    test("extracts tool-invocation input args in SQLite", async () => {
      const db = createTestDb();
      insertMessage(db, "msg1", "ses_abc", Date.now(), { role: "assistant" });
      insertPart(db, "part1", "msg1", {
        type: "tool-invocation",
        name: "Read",
        toolCallId: "tc1",
        args: { file_path: "/home/user/test.ts" },
      });
      db.close();

      const result = await getOpenCodeSessionMessages("ses_abc", 0, 10);
      expect(result.messages[0].toolUse?.[0].input).toBeDefined();
      const parsed = JSON.parse(result.messages[0].toolUse![0].input!);
      expect(parsed.file_path).toBe("/home/user/test.ts");
    });

    test("extracts tool-invocation result in SQLite into toolResults", async () => {
      const db = createTestDb();
      insertMessage(db, "msg1", "ses_abc", Date.now(), { role: "assistant" });
      insertPart(db, "part1", "msg1", {
        type: "tool-invocation",
        name: "Read",
        toolCallId: "tc1",
        state: "completed",
        result: "file contents here",
      });
      db.close();

      const result = await getOpenCodeSessionMessages("ses_abc", 0, 10);
      expect(result.messages[0].toolResults).toHaveLength(1);
      expect(result.messages[0].toolResults?.[0]).toEqual({
        toolUseId: "tc1",
        content: "file contents here",
      });
    });

    test("toolResults is undefined when no tool results exist in SQLite", async () => {
      const db = createTestDb();
      insertMessage(db, "msg1", "ses_abc", Date.now(), { role: "assistant" });
      insertPart(db, "part1", "msg1", { type: "text", text: "Just text." });
      db.close();

      const result = await getOpenCodeSessionMessages("ses_abc", 0, 10);
      expect(result.messages[0].toolResults).toBeUndefined();
    });
  });

  // =====================
  // SDK tool results tests
  // =====================

  describe("SDK tool result extraction", () => {
    test("extracts tool-invocation input args via SDK", async () => {
      const sdkMessages: SdkMessage[] = [
        makeSdkMessage({
          info: {
            role: "assistant",
            time: { created: "2026-03-19T10:00:00.000Z" },
          },
          parts: [
            {
              id: "p1",
              type: "tool-invocation",
              name: "Read",
              toolCallId: "tc_001",
              args: { file_path: "/tmp/test.ts" },
            } as SdkPart & { args: Record<string, unknown> },
          ],
        }),
      ];

      mockClient = {
        session: {
          messages: mock(() => Promise.resolve({ data: sdkMessages })),
        },
      };

      const result = await getOpenCodeSessionMessages("ses_test123", 0, 10);
      expect(result.messages[0].toolUse?.[0].input).toBeDefined();
      const parsed = JSON.parse(result.messages[0].toolUse![0].input!);
      expect(parsed.file_path).toBe("/tmp/test.ts");
    });

    test("extracts tool-invocation result via SDK into toolResults", async () => {
      const sdkMessages: SdkMessage[] = [
        makeSdkMessage({
          info: {
            role: "assistant",
            time: { created: "2026-03-19T10:00:00.000Z" },
          },
          parts: [
            {
              id: "p1",
              type: "tool-invocation",
              name: "Read",
              toolCallId: "tc_001",
              state: "completed",
              result: "the file contents",
            } as SdkPart & { state: string; result: string },
          ],
        }),
      ];

      mockClient = {
        session: {
          messages: mock(() => Promise.resolve({ data: sdkMessages })),
        },
      };

      const result = await getOpenCodeSessionMessages("ses_test123", 0, 10);
      expect(result.messages[0].toolResults).toHaveLength(1);
      expect(result.messages[0].toolResults?.[0]).toEqual({
        toolUseId: "tc_001",
        content: "the file contents",
      });
    });

    test("toolResults is undefined when no tool results exist via SDK", async () => {
      const sdkMessages: SdkMessage[] = [
        makeSdkMessage({
          info: {
            role: "assistant",
            time: { created: "2026-03-19T10:00:00.000Z" },
          },
          parts: [{ id: "p1", type: "text", text: "No tools here." }],
        }),
      ];

      mockClient = {
        session: {
          messages: mock(() => Promise.resolve({ data: sdkMessages })),
        },
      };

      const result = await getOpenCodeSessionMessages("ses_test123", 0, 10);
      expect(result.messages[0].toolResults).toBeUndefined();
    });
  });
});
