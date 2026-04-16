import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import type { Server } from "bun";
import {
  addRenameMapping,
  clearRenameMappings,
  resolveSessionName,
  startTerminalServer,
  validateModel,
  validateProjectDir,
  validateSessionId,
  validateSessionName,
} from "./terminal-server";

describe("resolveSessionName", () => {
  afterEach(() => {
    clearRenameMappings();
  });

  test("returns the same name if no rename happened", () => {
    expect(resolveSessionName("my-session")).toBe("my-session");
  });

  test("resolves a single rename", () => {
    addRenameMapping("old-name", "new-name");
    expect(resolveSessionName("old-name")).toBe("new-name");
  });

  test("follows a rename chain (A→B→C)", () => {
    addRenameMapping("session-a", "session-b");
    addRenameMapping("session-b", "session-c");
    expect(resolveSessionName("session-a")).toBe("session-c");
  });

  test("handles cycle without infinite loop", () => {
    addRenameMapping("x", "y");
    addRenameMapping("y", "x");
    const result = resolveSessionName("x");
    expect(["x", "y"]).toContain(result);
  });

  test("does not affect unrelated names", () => {
    addRenameMapping("foo", "bar");
    expect(resolveSessionName("unrelated")).toBe("unrelated");
  });
});

describe("validateSessionName", () => {
  test("accepts valid names", () => {
    expect(validateSessionName("my-session")).toBeNull();
    expect(validateSessionName("session_01")).toBeNull();
    expect(validateSessionName("test.name")).toBeNull();
    expect(validateSessionName("A")).toBeNull();
  });

  test("rejects empty name", () => {
    expect(validateSessionName("")).not.toBeNull();
  });

  test("rejects names with shell metacharacters", () => {
    expect(validateSessionName("foo;rm -rf /")).not.toBeNull();
    expect(validateSessionName("$(whoami)")).not.toBeNull();
    expect(validateSessionName("test`id`")).not.toBeNull();
    expect(validateSessionName("name with spaces")).not.toBeNull();
    expect(validateSessionName("foo&bar")).not.toBeNull();
  });

  test("rejects names exceeding 100 characters", () => {
    expect(validateSessionName("a".repeat(101))).not.toBeNull();
    expect(validateSessionName("a".repeat(100))).toBeNull();
  });
});

describe("validateProjectDir", () => {
  test("accepts valid absolute paths", () => {
    expect(validateProjectDir("/home/user/project")).toBeNull();
    expect(validateProjectDir("/tmp/test")).toBeNull();
    expect(validateProjectDir("/")).toBeNull();
  });

  test("rejects empty path", () => {
    expect(validateProjectDir("")).not.toBeNull();
  });

  test("rejects relative paths", () => {
    expect(validateProjectDir("relative/path")).not.toBeNull();
    expect(validateProjectDir("./local")).not.toBeNull();
  });

  test("rejects paths with directory traversal", () => {
    expect(validateProjectDir("/home/user/../etc/passwd")).not.toBeNull();
    expect(validateProjectDir("/tmp/../../etc")).not.toBeNull();
  });

  test("rejects paths with redundant slashes or dot segments", () => {
    expect(validateProjectDir("/home/user/./project")).not.toBeNull();
    expect(validateProjectDir("/home//user/project")).not.toBeNull();
    expect(validateProjectDir("/home/user/project/")).not.toBeNull();
  });

  test("returns the canonicalized path for valid inputs", () => {
    const result = validateProjectDir("/home/user/project");
    expect(result).toBeNull();
  });
});

describe("validateModel", () => {
  test("accepts valid model names", () => {
    expect(validateModel("claude-sonnet-4-5-20250514")).toBeNull();
    expect(validateModel("claude-opus-4-6")).toBeNull();
    expect(validateModel("anthropic/claude-3")).toBeNull();
  });

  test("rejects names with shell metacharacters", () => {
    expect(validateModel("model;rm -rf /")).not.toBeNull();
    expect(validateModel("$(whoami)")).not.toBeNull();
    expect(validateModel("model name")).not.toBeNull();
  });
});

describe("validateSessionId", () => {
  test("accepts valid UUIDs", () => {
    expect(validateSessionId("550e8400-e29b-41d4-a716-446655440000")).toBeNull();
    expect(validateSessionId("abc123")).toBeNull();
  });

  test("accepts OpenCode session IDs", () => {
    expect(validateSessionId("ses_30163a6c1ffeYDGuDOrp0nH9vG")).toBeNull();
    expect(validateSessionId("ses_abc123")).toBeNull();
  });

  test("rejects empty ID", () => {
    expect(validateSessionId("")).not.toBeNull();
  });

  test("rejects IDs with shell metacharacters", () => {
    expect(validateSessionId("test;injection")).not.toBeNull();
    expect(validateSessionId("../../../etc")).not.toBeNull();
    expect(validateSessionId("id$(whoami)")).not.toBeNull();
  });
});

describe("/api/send endpoint", () => {
  let server: Server;
  let baseUrl: string;

  beforeAll(() => {
    // Use a random high port to avoid conflicts
    const port = 14680 + Math.floor(Math.random() * 1000);
    server = startTerminalServer(port, "test-machine");
    baseUrl = `http://localhost:${port}`;
  });

  afterAll(() => {
    server.stop(true);
  });

  test("rejects missing session", async () => {
    const res = await fetch(`${baseUrl}/api/send`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: "hello" }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("Missing session or text");
  });

  test("rejects missing text", async () => {
    const res = await fetch(`${baseUrl}/api/send`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ session: "test-session" }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("Missing session or text");
  });

  test("rejects empty session and text", async () => {
    const res = await fetch(`${baseUrl}/api/send`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ session: "", text: "" }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("Missing session or text");
  });

  test("handles malformed JSON body", async () => {
    const res = await fetch(`${baseUrl}/api/send`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "not-json",
    });
    expect(res.status).toBe(500);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBeDefined();
  });
});
