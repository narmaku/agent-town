import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getPiSessionMessages, searchPiMessages } from "./message-parser";
import { clearPiSessionCache } from "./session-discovery";

const roots: string[] = [];

async function fixture(): Promise<{ root: string; path: string }> {
  const root = await mkdtemp(join(tmpdir(), "agent-town-pi-messages-"));
  roots.push(root);
  const path = join(root, "cwd", "session.jsonl");
  await mkdir(join(root, "cwd"), { recursive: true });
  await writeFile(
    path,
    [
      { type: "session", version: 3, id: "pi-session", cwd: "/work/pi", timestamp: "2026-09-10T00:00:00Z" },
      {
        type: "message",
        id: "root",
        parentId: null,
        timestamp: "2026-09-10T00:00:01Z",
        message: { role: "user", content: "shared root" },
      },
      {
        type: "message",
        id: "abandoned",
        parentId: "root",
        timestamp: "2026-09-10T00:00:02Z",
        message: { role: "assistant", content: "abandoned secret phrase" },
      },
      {
        type: "message",
        id: "active",
        parentId: "root",
        timestamp: "2026-09-10T00:00:03Z",
        message: { role: "assistant", content: "active searchable phrase" },
      },
      {
        type: "message",
        id: "final",
        parentId: "active",
        timestamp: "2026-09-10T00:00:04Z",
        message: { role: "user", content: "last message" },
      },
    ]
      .map((record) => JSON.stringify(record))
      .join("\n"),
  );
  return { root, path };
}

afterEach(async () => {
  clearPiSessionCache();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("Pi message parsing", () => {
  test("paginates from the end of the visible active branch", async () => {
    const { root } = await fixture();
    const response = await getPiSessionMessages("pi-session", 0, 2, root);
    expect(response.messages.map((message) => message.content)).toEqual(["active searchable phrase", "last message"]);
    expect(response.total).toBe(3);
    expect(response.hasMore).toBe(true);
  });

  test("searches visible messages and excludes abandoned branches", async () => {
    const { root } = await fixture();
    expect(await searchPiMessages("SEARCHABLE", 10, root)).toEqual([
      {
        sessionId: "pi-session",
        agentType: "pi",
        snippet: "active searchable phrase",
        matchCount: 1,
      },
    ]);
    expect(await searchPiMessages("secret", 10, root)).toEqual([]);
    expect(await searchPiMessages("phrase", 0, root)).toEqual([]);
  });

  test("throws for a missing session", async () => {
    const { root } = await fixture();
    expect(getPiSessionMessages("missing", 0, 20, root)).rejects.toThrow("Session not found");
  });
});
