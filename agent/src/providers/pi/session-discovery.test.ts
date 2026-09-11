import { afterEach, describe, expect, test } from "bun:test";
import { appendFile, mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  clearPiSessionCache,
  deletePiSessionData,
  discoverPiSessions,
  findPiSessionCandidates,
  findPiSessionPath,
  getPiSessionsDir,
} from "./session-discovery";

const roots: string[] = [];

async function makeRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "agent-town-pi-"));
  roots.push(root);
  return root;
}

async function writeSession(
  path: string,
  options: { id: string; cwd?: string; timestamp?: string; name?: string; content?: string } = { id: "pi-1" },
): Promise<void> {
  await mkdir(join(path, ".."), { recursive: true });
  const timestamp = options.timestamp ?? "2026-09-10T00:00:00.000Z";
  const records = [
    {
      type: "session",
      version: 3,
      id: options.id,
      cwd: options.cwd ?? "/work/pi",
      timestamp,
    },
    ...(options.name ? [{ type: "session_info", name: options.name }] : []),
    {
      type: "message",
      id: "user",
      parentId: null,
      timestamp,
      message: { role: "user", content: options.content ?? "build it" },
    },
    {
      type: "message",
      id: "assistant",
      parentId: "user",
      timestamp,
      message: {
        role: "assistant",
        model: "pi-model",
        content: [{ type: "text", text: "done" }],
        usage: { input: 10, output: 4 },
      },
    },
  ];
  await writeFile(path, records.map((record) => JSON.stringify(record)).join("\n"));
}

afterEach(async () => {
  clearPiSessionCache();
  delete process.env.PI_CODING_AGENT_DIR;
  delete process.env.PI_CODING_AGENT_SESSION_DIR;
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("Pi session discovery", () => {
  test("resolves documented agent and session directory overrides", () => {
    process.env.PI_CODING_AGENT_DIR = "/custom/agent";
    expect(getPiSessionsDir()).toBe("/custom/agent/sessions");
    process.env.PI_CODING_AGENT_SESSION_DIR = "/custom/sessions";
    expect(getPiSessionsDir()).toBe("/custom/sessions");
  });

  test("discovers direct and cwd-bucket sessions but excludes nested artifacts and invalid JSONL", async () => {
    const root = await makeRoot();
    await writeSession(join(root, "direct.jsonl"), { id: "direct", name: "Direct session" });
    await writeSession(join(root, "encoded-work", "bucket.jsonl"), { id: "bucket" });
    await writeSession(join(root, "encoded-work", "artifacts", "nested.jsonl"), { id: "nested" });
    await writeFile(join(root, "notes.jsonl"), '{"type":"event","id":"not-a-session"}');

    const sessions = await discoverPiSessions({ sessionsDir: root, nowMs: Date.parse("2026-09-10T00:00:10Z") });

    expect(sessions.map((session) => session.sessionId).sort()).toEqual(["bucket", "direct"]);
    expect(sessions.find((session) => session.sessionId === "direct")).toMatchObject({
      agentType: "pi",
      slug: "Direct session",
      cwd: "/work/pi",
      projectName: "pi",
      model: "pi-model",
      totalInputTokens: 10,
      totalOutputTokens: 4,
      lastMessage: "done",
      lastAssistantMessage: "done",
    });
  });

  test("enforces retention and invalidates the per-file cache when a file changes", async () => {
    const root = await makeRoot();
    const path = join(root, "session.jsonl");
    await writeSession(path, { id: "cached", content: "before" });

    const first = await discoverPiSessions({ sessionsDir: root, nowMs: Date.now() });
    await writeSession(path, { id: "changed", content: "after" });
    const second = await discoverPiSessions({ sessionsDir: root, nowMs: Date.now() });
    expect(first[0]?.sessionId).toBe("cached");
    expect(second[0]?.sessionId).toBe("changed");

    const metadata = await stat(path);
    const expired = await discoverPiSessions({
      sessionsDir: root,
      nowMs: metadata.mtimeMs + 31 * 24 * 60 * 60 * 1000,
    });
    expect(expired).toEqual([]);
  });

  test("finds and deletes only the file whose header has the exact session ID", async () => {
    const root = await makeRoot();
    const exact = join(root, "timestamp_random.jsonl");
    const similar = join(root, "timestamp_similar.jsonl");
    await writeSession(exact, { id: "project.session-7" });
    await writeSession(similar, { id: "project.session-70" });

    expect(await findPiSessionPath("project.session-7", root)).toBe(exact);
    expect(await deletePiSessionData("project.session-7", root)).toBe(true);
    expect(await Bun.file(exact).exists()).toBe(false);
    expect(await Bun.file(similar).exists()).toBe(true);
    expect(await deletePiSessionData("missing", root)).toBe(false);
  });

  test("scopes cached header matches to the requested session root", async () => {
    const firstRoot = await makeRoot();
    const secondRoot = await makeRoot();
    const first = join(firstRoot, "first.jsonl");
    const second = join(secondRoot, "second.jsonl");
    await writeSession(first, { id: "same-id" });
    await writeSession(second, { id: "same-id" });

    await discoverPiSessions({ sessionsDir: firstRoot });
    expect(await deletePiSessionData("same-id", secondRoot)).toBe(true);
    expect(await Bun.file(first).exists()).toBe(true);
    expect(await Bun.file(second).exists()).toBe(false);
  });

  test("uses the latest session metadata, model change, and file activity", async () => {
    const root = await makeRoot();
    const path = join(root, "metadata.jsonl");
    await writeSession(path, { id: "metadata", name: "Old name", timestamp: "2020-01-01T00:00:00Z" });
    await appendFile(
      path,
      `\n${[
        {
          type: "session_info",
          id: "info-new",
          parentId: "assistant",
          timestamp: "2020-01-01T00:00:01Z",
          name: "Current name",
        },
        {
          type: "model_change",
          id: "model-new",
          parentId: "info-new",
          timestamp: "2020-01-01T00:00:02Z",
          provider: "openai",
          modelId: "gpt-current",
        },
      ]
        .map((record) => JSON.stringify(record))
        .join("\n")}`,
    );
    const metadata = await stat(path);

    const sessions = await discoverPiSessions({ sessionsDir: root, nowMs: metadata.mtimeMs + 10_000 });
    expect(sessions[0]).toMatchObject({
      slug: "Current name",
      model: "gpt-current",
      lastActivity: new Date(metadata.mtimeMs).toISOString(),
      status: "working",
    });
  });

  test("exposes process candidates using header creation time", async () => {
    const root = await makeRoot();
    await writeSession(join(root, "candidate.jsonl"), {
      id: "candidate",
      cwd: "/work/candidate",
      timestamp: "2026-09-10T01:02:03Z",
    });

    expect(await findPiSessionCandidates(root)).toEqual([
      { id: "candidate", cwd: "/work/candidate", createdAtMs: Date.parse("2026-09-10T01:02:03Z") },
    ]);
  });
});
