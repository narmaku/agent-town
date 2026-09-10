import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { clearCodexSessionCache, discoverCodexSessions, getCodexHome } from "./session-discovery";

const ACTIVE_ID = "550e8400-e29b-41d4-a716-446655440000";
const ARCHIVED_ID = "550e8400-e29b-41d4-a716-446655440001";
const SUBAGENT_ID = "550e8400-e29b-41d4-a716-446655440002";
const EXPIRED_ID = "550e8400-e29b-41d4-a716-446655440003";

describe("discoverCodexSessions", () => {
  let codexHome: string;
  const originalCodexHome = process.env.CODEX_HOME;

  beforeEach(() => {
    codexHome = mkdtempSync(join(tmpdir(), "codex-sessions-"));
    clearCodexSessionCache();
  });

  afterEach(() => {
    if (originalCodexHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = originalCodexHome;
    clearCodexSessionCache();
    rmSync(codexHome, { recursive: true, force: true });
  });

  test("honors CODEX_HOME", () => {
    process.env.CODEX_HOME = codexHome;
    expect(getCodexHome()).toBe(codexHome);
  });

  test("reads retained active top-level threads from the newest compatible state database", async () => {
    createStateDatabase(join(codexHome, "state_5.sqlite"), [
      thread(ACTIVE_ID, { title: "Provider work", cwd: "/work/agent-town", model: "gpt-5.3-codex" }),
      thread(ARCHIVED_ID, { archived: 1 }),
      thread(SUBAGENT_ID, { source: "subagent" }),
      thread(EXPIRED_ID, { updated_at: Date.now() - 8 * 24 * 60 * 60 * 1000 }),
    ]);

    const sessions = await discoverCodexSessions({ codexHome });

    expect(sessions).toHaveLength(1);
    expect(sessions[0]).toMatchObject({
      sessionId: ACTIVE_ID,
      agentType: "codex",
      slug: "Provider work",
      cwd: "/work/agent-town",
      projectName: "agent-town",
      model: "gpt-5.3-codex",
    });
  });

  test("falls back to bounded rollout discovery when the database schema is incompatible", async () => {
    const db = new Database(join(codexHome, "state_99.sqlite"), { create: true });
    db.run("CREATE TABLE unrelated (value TEXT)");
    db.close();
    const rolloutDir = join(codexHome, "sessions", "2026", "09", "10");
    mkdirSync(rolloutDir, { recursive: true });
    writeFileSync(
      join(rolloutDir, `rollout-${ACTIVE_ID}.jsonl`),
      [
        JSON.stringify({
          timestamp: new Date().toISOString(),
          type: "session_meta",
          payload: {
            id: ACTIVE_ID,
            cwd: "/work/fallback",
            source: "cli",
            cli_version: "0.153.4",
            model: "gpt-5.3-codex",
          },
        }),
        "{truncated",
        JSON.stringify({
          timestamp: new Date().toISOString(),
          type: "event_msg",
          payload: { type: "agent_message", message: "Fallback works" },
        }),
        JSON.stringify({
          timestamp: new Date().toISOString(),
          type: "event_msg",
          payload: {
            type: "token_count",
            info: {
              last_token_usage: { input_tokens: 40, output_tokens: 15, total_tokens: 55 },
              total_token_usage: { input_tokens: 200, output_tokens: 40 },
              model_context_window: 258_400,
            },
          },
        }),
      ].join("\n"),
    );

    const sessions = await discoverCodexSessions({ codexHome });

    expect(sessions).toHaveLength(1);
    expect(sessions[0]).toMatchObject({
      sessionId: ACTIVE_ID,
      cwd: "/work/fallback",
      lastMessage: "Fallback works",
      version: "0.153.4",
      totalInputTokens: 200,
      totalOutputTokens: 40,
      contextTokens: 55,
    });
  });

  test("isolates malformed rollouts and excludes subagent rollouts", async () => {
    const rolloutDir = join(codexHome, "sessions", "2026", "09", "10");
    mkdirSync(rolloutDir, { recursive: true });
    writeFileSync(join(rolloutDir, "broken.jsonl"), "not-json\n");
    writeFileSync(
      join(rolloutDir, `rollout-${SUBAGENT_ID}.jsonl`),
      JSON.stringify({
        timestamp: new Date().toISOString(),
        type: "session_meta",
        payload: { id: SUBAGENT_ID, cwd: "/work/subagent", source: { subagent: "review" } },
      }),
    );

    expect(await discoverCodexSessions({ codexHome })).toEqual([]);
  });

  test("uses rollout modification time as activity time on cached discovery", async () => {
    const nowMs = Date.parse("2026-09-10T12:00:00.000Z");
    const activityMs = nowMs - 10_000;
    const rolloutDir = join(codexHome, "sessions", "2026", "09", "10");
    const rolloutPath = join(rolloutDir, `rollout-${ACTIVE_ID}.jsonl`);
    mkdirSync(rolloutDir, { recursive: true });
    writeFileSync(
      rolloutPath,
      JSON.stringify({
        timestamp: "2026-09-01T00:00:00.000Z",
        type: "session_meta",
        payload: {
          id: ACTIVE_ID,
          cwd: "/work/active",
          source: "cli",
          timestamp: "2026-09-01T00:00:00.000Z",
        },
      }),
    );
    utimesSync(rolloutPath, activityMs / 1000, activityMs / 1000);

    const first = await discoverCodexSessions({ codexHome, nowMs });
    const cached = await discoverCodexSessions({ codexHome, nowMs: nowMs + 35_000 });

    expect(first[0].lastActivity).toBe(new Date(activityMs).toISOString());
    expect(cached[0].status).toBe("awaiting_input");
  });

  test("expires cached sessions when they pass the retention window", async () => {
    const nowMs = Date.parse("2026-09-10T12:00:00.000Z");
    createStateDatabase(join(codexHome, "state_5.sqlite"), [thread(ACTIVE_ID, { updated_at: nowMs - 1_000 })]);

    expect(await discoverCodexSessions({ codexHome, nowMs })).toHaveLength(1);
    expect(
      await discoverCodexSessions({
        codexHome,
        nowMs: nowMs + 7 * 24 * 60 * 60 * 1000,
      }),
    ).toEqual([]);
  });
});

interface ThreadRow {
  id: string;
  cwd: string;
  title: string;
  created_at: number;
  updated_at: number;
  source: string;
  archived: number;
  rollout_path: string;
  model: string;
  git_branch: string;
}

function thread(id: string, overrides: Partial<ThreadRow> = {}): ThreadRow {
  return {
    id,
    cwd: "/work/default",
    title: "Default title",
    created_at: Date.now() - 60_000,
    updated_at: Date.now(),
    source: "cli",
    archived: 0,
    rollout_path: "",
    model: "",
    git_branch: "main",
    ...overrides,
  };
}

function createStateDatabase(path: string, rows: ThreadRow[]): void {
  const db = new Database(path, { create: true });
  db.run(
    "CREATE TABLE threads (id TEXT PRIMARY KEY, cwd TEXT, title TEXT, created_at INTEGER, updated_at INTEGER, source TEXT, archived INTEGER, rollout_path TEXT, model TEXT, git_branch TEXT)",
  );
  const insert = db.prepare(
    "INSERT INTO threads (id, cwd, title, created_at, updated_at, source, archived, rollout_path, model, git_branch) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
  );
  for (const row of rows) {
    insert.run(
      row.id,
      row.cwd,
      row.title,
      row.created_at,
      row.updated_at,
      row.source,
      row.archived,
      row.rollout_path,
      row.model,
      row.git_branch,
    );
  }
  db.close();
}
