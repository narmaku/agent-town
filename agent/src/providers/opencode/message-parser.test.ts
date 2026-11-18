import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// --- Mocking setup ---
// mock.module requires the absolute path with .ts extension to correctly
// intercept transitive imports from message-parser.ts.

const PROVIDER_DIR = import.meta.dir;
const SESSION_DISCOVERY_PATH = join(PROVIDER_DIR, "session-discovery.ts");

let tempDir: string;
let dbPath: string;

// Initial mock for session-discovery (will be re-mocked in beforeEach with correct path)
mock.module(SESSION_DISCOVERY_PATH, () => ({
  OPENCODE_DB_PATH: "",
}));

// Now import the function under test AFTER mocking
const { getOpenCodeSessionMessages } = await import("./message-parser");

describe("getOpenCodeSessionMessages", () => {
  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "opencode-msg-test-"));
    dbPath = join(tempDir, "opencode.db");

    // Re-mock session-discovery with the current temp db path
    mock.module(SESSION_DISCOVERY_PATH, () => ({
      OPENCODE_DB_PATH: dbPath,
    }));
  });

  afterEach(async () => {
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
  // SQLite fallback tests
  // =====================

  describe("via SQLite", () => {
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
      const parsed = JSON.parse(result.messages[0].toolUse?.[0]?.input ?? "");
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
  // SQLite token usage tests
  // =====================

  describe("SQLite token usage extraction", () => {
    test("extracts token usage from SQLite message data.tokens", async () => {
      const db = createTestDb();
      insertMessage(db, "msg1", "ses_abc", Date.now(), {
        role: "assistant",
        modelID: "gpt-4o",
        tokens: { input: 300, output: 100 },
      });
      insertPart(db, "part1", "msg1", { type: "text", text: "Response." });
      db.close();

      const result = await getOpenCodeSessionMessages("ses_abc", 0, 10);
      expect(result.messages[0].tokenUsage).toBeDefined();
      expect(result.messages[0].tokenUsage?.inputTokens).toBe(300);
      expect(result.messages[0].tokenUsage?.outputTokens).toBe(100);
    });

    test("tokenUsage is undefined when tokens field is missing from SQLite data", async () => {
      const db = createTestDb();
      insertMessage(db, "msg1", "ses_abc", Date.now(), { role: "assistant" });
      insertPart(db, "part1", "msg1", { type: "text", text: "No tokens." });
      db.close();

      const result = await getOpenCodeSessionMessages("ses_abc", 0, 10);
      expect(result.messages[0].tokenUsage).toBeUndefined();
    });
  });
});
