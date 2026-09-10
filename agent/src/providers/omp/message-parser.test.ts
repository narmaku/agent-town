import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { getOmpSessionMessages, searchOmpMessages } from "./message-parser";
import { clearOmpSessionCache } from "./session-discovery";
import { serializeOmpTitleSlotForTest } from "./session-parser";

const roots: string[] = [];

async function fixture(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "agent-town-omp-messages-"));
  roots.push(root);
  const bucket = join(root, "-work-omp");
  await mkdir(bucket, { recursive: true });
  const records = [
    { type: "session", version: 3, id: "omp.session-1", cwd: "/work/omp", timestamp: 1_788_969_600 },
    {
      type: "message",
      id: "root",
      parentId: null,
      timestamp: 1_788_969_601,
      message: { role: "user", content: "pre reset hidden phrase" },
    },
    {
      type: "message",
      id: "abandoned",
      parentId: "root",
      timestamp: 1_788_969_602,
      message: { role: "assistant", content: "abandoned secret phrase" },
    },
    { type: "reset_boundary", id: "reset", parentId: "root", timestamp: 1_788_969_603 },
    {
      type: "message",
      id: "active",
      parentId: "reset",
      timestamp: 1_788_969_604,
      message: { role: "user", content: "active searchable phrase" },
    },
    {
      type: "message",
      id: "answer",
      parentId: "active",
      timestamp: 1_788_969_605,
      message: {
        role: "assistant",
        content: [
          { type: "thinking", text: "searchable thought" },
          { type: "text", text: "latest answer" },
        ],
      },
    },
  ];
  await writeFile(
    join(bucket, "session.jsonl"),
    `${serializeOmpTitleSlotForTest("Message fixture")}${records.map((record) => JSON.stringify(record)).join("\n")}`,
  );

  const nested = join(bucket, "subagent-artifacts");
  await mkdir(nested);
  await writeFile(
    join(nested, "child.jsonl"),
    [
      { type: "session", version: 3, id: "child", cwd: "/work/omp" },
      { type: "message", id: "child-message", parentId: null, message: { role: "user", content: "nested needle" } },
    ]
      .map((record) => JSON.stringify(record))
      .join("\n"),
  );
  return root;
}

afterEach(async () => {
  clearOmpSessionCache();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("OMP message access", () => {
  test("paginates from the end of the visible post-reset active branch", async () => {
    const root = await fixture();
    const response = await getOmpSessionMessages("omp.session-1", 0, 1, root);
    expect(response.messages).toEqual([
      expect.objectContaining({ content: "latest answer", thinking: "searchable thought" }),
    ]);
    expect(response.total).toBe(2);
    expect(response.hasMore).toBe(true);
  });

  test("searches visible primary histories and excludes reset, abandoned, and nested content", async () => {
    const root = await fixture();
    expect(await searchOmpMessages("SEARCHABLE", 10, root)).toEqual([
      {
        sessionId: "omp.session-1",
        agentType: "omp",
        snippet: "active searchable phrase",
        matchCount: 2,
      },
    ]);
    expect(await searchOmpMessages("hidden", 10, root)).toEqual([]);
    expect(await searchOmpMessages("secret", 10, root)).toEqual([]);
    expect(await searchOmpMessages("nested", 10, root)).toEqual([]);
    expect(await searchOmpMessages("phrase", 0, root)).toEqual([]);
  });

  test("throws for a missing session", async () => {
    const root = await fixture();
    expect(getOmpSessionMessages("missing", 0, 20, root)).rejects.toThrow("Session not found");
  });
});
