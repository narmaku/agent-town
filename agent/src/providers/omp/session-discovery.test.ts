import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { applyProviderStatusFallback } from "../../session-status";
import {
  clearOmpSessionCache,
  deleteOmpSessionData,
  discoverOmpSessions,
  findOmpSessionCandidates,
  findOmpSessionPath,
  getOmpAgentDir,
  getOmpSessionsDir,
} from "./session-discovery";
import { serializeOmpTitleSlotForTest } from "./session-parser";

const roots: string[] = [];

async function makeRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "agent-town-omp-"));
  roots.push(root);
  return root;
}

async function writeSession(
  path: string,
  options: {
    id: string;
    cwd?: string;
    timestamp?: string;
    title?: string;
    current?: boolean;
    stopReason?: string;
    terminalRecord?: Record<string, unknown>;
  },
): Promise<void> {
  await mkdir(join(path, ".."), { recursive: true });
  const timestamp = options.timestamp ?? "2026-09-10T00:00:00.000Z";
  const records = [
    {
      type: "session",
      version: options.current === false ? 1 : 3,
      id: options.id,
      cwd: options.cwd ?? "/work/omp",
      timestamp,
      title: options.current === false ? options.title : undefined,
    },
    {
      type: "message",
      id: "user",
      parentId: null,
      timestamp,
      message: { role: "user", content: "build it" },
    },
    {
      type: "message",
      id: "assistant",
      parentId: "user",
      timestamp,
      message: {
        role: "assistant",
        model: "openai/gpt-5.2",
        stopReason: options.stopReason,
        content: [{ type: "text", text: "done" }],
        usage: { input: 21, output: 9 },
      },
    },
    ...(options.terminalRecord ? [options.terminalRecord] : []),
  ];
  const logical = records.map((record) => JSON.stringify(record)).join("\n");
  await writeFile(
    path,
    options.current === false ? logical : `${serializeOmpTitleSlotForTest(options.title ?? "")}${logical}`,
  );
}

afterEach(async () => {
  clearOmpSessionCache();
  delete process.env.PI_CODING_AGENT_DIR;
  delete process.env.OMP_PROFILE;
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("OMP session discovery", () => {
  test("resolves the default, agent directory override, and active profile roots", () => {
    expect(getOmpAgentDir()).toMatch(/\.omp\/agent$/);
    process.env.OMP_PROFILE = "work";
    expect(getOmpAgentDir()).toMatch(/\.omp\/profiles\/work\/agent$/);
    process.env.PI_CODING_AGENT_DIR = "/custom/omp-agent";
    expect(getOmpAgentDir()).toBe("/custom/omp-agent");
    expect(getOmpSessionsDir()).toBe("/custom/omp-agent/sessions");
  });

  test("discovers only primary JSONL files directly inside session buckets", async () => {
    const root = await makeRoot();
    await writeSession(join(root, "-work-omp", "current.jsonl"), {
      id: "0199a8d7-9d84-7000-a123-123456789abc",
      title: "Current title",
    });
    await writeSession(join(root, "--legacy-work--", "legacy.jsonl"), {
      id: "legacy.session-a",
      title: "Legacy title",
      current: false,
    });
    await writeSession(join(root, "root-level.jsonl"), { id: "root-level" });
    await writeSession(join(root, "-work-omp", "subagent-artifacts", "nested.jsonl"), { id: "nested" });
    await writeFile(join(root, "-work-omp", "invalid.jsonl"), '{"type":"event"}');

    const sessions = await discoverOmpSessions({ sessionsDir: root, nowMs: Date.parse("2026-09-10T00:00:10Z") });

    expect(sessions.map((session) => session.sessionId).sort()).toEqual([
      "0199a8d7-9d84-7000-a123-123456789abc",
      "legacy.session-a",
    ]);
    expect(sessions.find((session) => session.sessionId.startsWith("0199"))).toMatchObject({
      agentType: "omp",
      slug: "Current title",
      cwd: "/work/omp",
      projectName: "omp",
      model: "openai/gpt-5.2",
      totalInputTokens: 21,
      totalOutputTokens: 9,
      lastMessage: "done",
      lastAssistantMessage: "done",
      status: "done",
    });
  });

  test("preserves lifecycle completion, failure, interruption, and pending states", async () => {
    const root = await makeRoot();
    await writeSession(join(root, "bucket", "normal.jsonl"), {
      id: "normal",
      terminalRecord: {
        type: "custom",
        customType: "session_exit",
        data: { reason: "dispose", kind: "normal", recordedAt: "2026-09-10T00:00:01Z" },
      },
    });
    await writeSession(join(root, "bucket", "fatal.jsonl"), {
      id: "fatal",
      terminalRecord: {
        type: "custom",
        customType: "session_exit",
        data: { reason: "uncaught_exception", kind: "fatal", recordedAt: "2026-09-10T00:00:01Z" },
      },
    });
    await writeSession(join(root, "bucket", "interrupted.jsonl"), { id: "interrupted", stopReason: "aborted" });
    await writeSession(join(root, "bucket", "pending.jsonl"), {
      id: "pending",
      terminalRecord: {
        type: "custom",
        customType: "session_exit",
        data: {
          reason: "process_exit",
          kind: "process_exit",
          recordedAt: "2026-09-10T00:00:01Z",
          pendingToolCalls: [{ toolName: "bash" }],
        },
      },
    });

    const sessions = await discoverOmpSessions({ sessionsDir: root, nowMs: Date.parse("2026-09-10T00:05:00Z") });
    const statuses = Object.fromEntries(sessions.map((session) => [session.sessionId, session.status]));
    expect(statuses).toEqual({ fatal: "error", interrupted: "exited", normal: "done", pending: "working" });
  });

  test("keeps OMP authoritative lifecycle states when no process is mapped", () => {
    const session = {
      sessionId: "done",
      agentType: "omp" as const,
      slug: "done",
      projectPath: "/work",
      projectName: "work",
      gitBranch: "",
      status: "done" as const,
      lastActivity: "2026-09-10T00:00:00Z",
      lastMessage: "",
      cwd: "/work",
    };

    applyProviderStatusFallback(session, undefined);
    expect(session.status).toBe("done");

    const pending = { ...session, sessionId: "pending", status: "working" as const };
    applyProviderStatusFallback(pending, undefined);
    expect(pending.status).toBe("working");
  });

  test("invalidates cache changes and enforces retention", async () => {
    const root = await makeRoot();
    const path = join(root, "bucket", "session.jsonl");
    await writeSession(path, { id: "before" });
    const first = await discoverOmpSessions({ sessionsDir: root, nowMs: Date.now() });
    await writeSession(path, { id: "after" });
    const second = await discoverOmpSessions({ sessionsDir: root, nowMs: Date.now() });
    expect(first[0]?.sessionId).toBe("before");
    expect(second[0]?.sessionId).toBe("after");

    const metadata = await stat(path);
    expect(
      await discoverOmpSessions({ sessionsDir: root, nowMs: metadata.mtimeMs + 31 * 24 * 60 * 60 * 1000 }),
    ).toEqual([]);
  });

  test("finds exact header IDs and deletes only their JSONL and same-stem artifacts", async () => {
    const root = await makeRoot();
    const exact = join(root, "bucket", "timestamp_exact.jsonl");
    const similar = join(root, "bucket", "timestamp_similar.jsonl");
    const exactArtifacts = join(root, "bucket", "timestamp_exact");
    const similarArtifacts = join(root, "bucket", "timestamp_similar");
    await writeSession(exact, { id: "opaque.session-7" });
    await writeSession(similar, { id: "opaque.session-70" });
    await mkdir(exactArtifacts);
    await mkdir(similarArtifacts);
    await writeFile(join(exactArtifacts, "0.txt"), "exact");
    await writeFile(join(similarArtifacts, "0.txt"), "similar");

    expect(await findOmpSessionPath("opaque.session-7", root)).toBe(exact);
    expect(await deleteOmpSessionData("opaque.session-7", root)).toBe(true);
    expect(await Bun.file(exact).exists()).toBe(false);
    expect(await Bun.file(join(exactArtifacts, "0.txt")).exists()).toBe(false);
    expect(await Bun.file(similar).exists()).toBe(true);
    expect(await Bun.file(join(similarArtifacts, "0.txt")).exists()).toBe(true);
    expect(await deleteOmpSessionData("missing", root)).toBe(false);
  });

  test("exposes process candidates using authoritative header data", async () => {
    const root = await makeRoot();
    await writeSession(join(root, "bucket", "not-the-id.jsonl"), {
      id: "candidate.id",
      cwd: "/work/candidate",
      timestamp: "2026-09-10T01:02:03Z",
    });

    expect(await findOmpSessionCandidates(root)).toEqual([
      { id: "candidate.id", cwd: "/work/candidate", createdAtMs: Date.parse("2026-09-10T01:02:03Z") },
    ]);
  });
});
