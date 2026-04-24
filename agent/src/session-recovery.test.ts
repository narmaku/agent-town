import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  buildWrapperScript,
  cleanupSessionRecoveryFiles,
  readSessionMetadata,
  writeSessionMetadata,
  type SessionMetadata,
  SESSION_RECOVERY_DIR_NAME,
} from "./session-recovery";

// Use a temp directory to avoid touching real state
const TEST_BASE_DIR = join(tmpdir(), `agent-town-recovery-test-${process.pid}`);

beforeEach(() => {
  mkdirSync(TEST_BASE_DIR, { recursive: true });
});

afterEach(() => {
  rmSync(TEST_BASE_DIR, { recursive: true, force: true });
});

describe("buildWrapperScript", () => {
  test("generates a bash script that launches claude with resume when session file exists", () => {
    const script = buildWrapperScript({
      muxSessionName: "my-session",
      projectDir: "/home/user/project",
      baseDir: TEST_BASE_DIR,
    });

    expect(script).toContain("#!/usr/bin/env bash");
    expect(script).toContain("--resume");
    expect(script).toContain("exec claude");
    expect(script).toContain("cd /home/user/project");
  });

  test("includes --dangerously-skip-permissions when autonomous is true", () => {
    const script = buildWrapperScript({
      muxSessionName: "my-session",
      projectDir: "/home/user/project",
      autonomous: true,
      baseDir: TEST_BASE_DIR,
    });

    expect(script).toContain("--dangerously-skip-permissions");
    // Should appear in both the resume and fresh launch paths
    const matches = script.match(/--dangerously-skip-permissions/g);
    expect(matches).not.toBeNull();
    expect(matches!.length).toBeGreaterThanOrEqual(2);
  });

  test("includes --model flag when model is specified", () => {
    const script = buildWrapperScript({
      muxSessionName: "my-session",
      projectDir: "/home/user/project",
      model: "claude-opus-4-6",
      baseDir: TEST_BASE_DIR,
    });

    expect(script).toContain("--model claude-opus-4-6");
  });

  test("includes both model and autonomous flags", () => {
    const script = buildWrapperScript({
      muxSessionName: "my-session",
      projectDir: "/home/user/project",
      model: "claude-opus-4-6",
      autonomous: true,
      baseDir: TEST_BASE_DIR,
    });

    expect(script).toContain("--model claude-opus-4-6");
    expect(script).toContain("--dangerously-skip-permissions");
  });

  test("does not include --dangerously-skip-permissions when autonomous is false", () => {
    const script = buildWrapperScript({
      muxSessionName: "my-session",
      projectDir: "/home/user/project",
      autonomous: false,
      baseDir: TEST_BASE_DIR,
    });

    expect(script).not.toContain("--dangerously-skip-permissions");
  });

  test("does not include --model when model is undefined", () => {
    const script = buildWrapperScript({
      muxSessionName: "my-session",
      projectDir: "/home/user/project",
      baseDir: TEST_BASE_DIR,
    });

    expect(script).not.toContain("--model");
  });

  test("references the correct session metadata file path", () => {
    const script = buildWrapperScript({
      muxSessionName: "test-session",
      projectDir: "/home/user/project",
      baseDir: TEST_BASE_DIR,
    });

    const expectedPath = join(TEST_BASE_DIR, SESSION_RECOVERY_DIR_NAME, "test-session.json");
    expect(script).toContain(expectedPath);
  });

  test("fresh launch uses exec to replace the shell process", () => {
    const script = buildWrapperScript({
      muxSessionName: "my-session",
      projectDir: "/home/user/project",
      baseDir: TEST_BASE_DIR,
    });

    // Both resume and fresh paths should use exec
    const execMatches = script.match(/exec claude/g);
    expect(execMatches).not.toBeNull();
    expect(execMatches!.length).toBe(2);
  });

  test("escapes project dir with single quotes for safety", () => {
    const script = buildWrapperScript({
      muxSessionName: "my-session",
      projectDir: "/home/user/my project",
      baseDir: TEST_BASE_DIR,
    });

    // shellEscape wraps paths with special chars in single quotes
    expect(script).toContain("'/home/user/my project'");
  });
});

describe("writeSessionMetadata", () => {
  test("writes metadata to disk as JSON", () => {
    const metadata: SessionMetadata = {
      sessionId: "550e8400-e29b-41d4-a716-446655440000",
      agentType: "claude-code",
      projectDir: "/home/user/project",
      autonomous: false,
      createdAt: "2026-04-24T10:00:00.000Z",
    };

    writeSessionMetadata("my-session", metadata, TEST_BASE_DIR);

    const filePath = join(TEST_BASE_DIR, SESSION_RECOVERY_DIR_NAME, "my-session.json");
    expect(existsSync(filePath)).toBe(true);

    const written = JSON.parse(readFileSync(filePath, "utf-8")) as SessionMetadata;
    expect(written.sessionId).toBe("550e8400-e29b-41d4-a716-446655440000");
    expect(written.agentType).toBe("claude-code");
    expect(written.projectDir).toBe("/home/user/project");
    expect(written.autonomous).toBe(false);
    expect(written.createdAt).toBe("2026-04-24T10:00:00.000Z");
  });

  test("creates the directory if it does not exist", () => {
    const nestedDir = join(TEST_BASE_DIR, "nested", "path");

    const metadata: SessionMetadata = {
      sessionId: "abc-123",
      agentType: "claude-code",
      projectDir: "/tmp",
      autonomous: false,
      createdAt: new Date().toISOString(),
    };

    writeSessionMetadata("test-session", metadata, nestedDir);

    const filePath = join(nestedDir, SESSION_RECOVERY_DIR_NAME, "test-session.json");
    expect(existsSync(filePath)).toBe(true);
  });

  test("overwrites existing metadata file", () => {
    const metadataDir = join(TEST_BASE_DIR, SESSION_RECOVERY_DIR_NAME);
    mkdirSync(metadataDir, { recursive: true });
    const filePath = join(metadataDir, "my-session.json");
    writeFileSync(filePath, JSON.stringify({ sessionId: "old-id" }));

    const newMetadata: SessionMetadata = {
      sessionId: "new-id",
      agentType: "claude-code",
      projectDir: "/tmp",
      autonomous: true,
      createdAt: new Date().toISOString(),
    };

    writeSessionMetadata("my-session", newMetadata, TEST_BASE_DIR);

    const written = JSON.parse(readFileSync(filePath, "utf-8")) as SessionMetadata;
    expect(written.sessionId).toBe("new-id");
    expect(written.autonomous).toBe(true);
  });

  test("includes model when present", () => {
    const metadata: SessionMetadata = {
      sessionId: "abc-123",
      agentType: "claude-code",
      projectDir: "/tmp",
      autonomous: false,
      model: "claude-opus-4-6",
      createdAt: new Date().toISOString(),
    };

    writeSessionMetadata("model-session", metadata, TEST_BASE_DIR);

    const filePath = join(TEST_BASE_DIR, SESSION_RECOVERY_DIR_NAME, "model-session.json");
    const written = JSON.parse(readFileSync(filePath, "utf-8")) as SessionMetadata;
    expect(written.model).toBe("claude-opus-4-6");
  });
});

describe("readSessionMetadata", () => {
  test("reads metadata from disk", () => {
    const metadataDir = join(TEST_BASE_DIR, SESSION_RECOVERY_DIR_NAME);
    mkdirSync(metadataDir, { recursive: true });

    const metadata: SessionMetadata = {
      sessionId: "abc-123",
      agentType: "claude-code",
      projectDir: "/tmp",
      autonomous: false,
      createdAt: "2026-04-24T10:00:00.000Z",
    };
    writeFileSync(join(metadataDir, "my-session.json"), JSON.stringify(metadata));

    const result = readSessionMetadata("my-session", TEST_BASE_DIR);
    expect(result).not.toBeNull();
    expect(result!.sessionId).toBe("abc-123");
    expect(result!.agentType).toBe("claude-code");
  });

  test("returns null when file does not exist", () => {
    const result = readSessionMetadata("nonexistent", TEST_BASE_DIR);
    expect(result).toBeNull();
  });

  test("returns null when file contains invalid JSON", () => {
    const metadataDir = join(TEST_BASE_DIR, SESSION_RECOVERY_DIR_NAME);
    mkdirSync(metadataDir, { recursive: true });
    writeFileSync(join(metadataDir, "bad.json"), "not json");

    const result = readSessionMetadata("bad", TEST_BASE_DIR);
    expect(result).toBeNull();
  });

  test("returns null when file is missing sessionId", () => {
    const metadataDir = join(TEST_BASE_DIR, SESSION_RECOVERY_DIR_NAME);
    mkdirSync(metadataDir, { recursive: true });
    writeFileSync(join(metadataDir, "incomplete.json"), JSON.stringify({ agentType: "claude-code" }));

    const result = readSessionMetadata("incomplete", TEST_BASE_DIR);
    expect(result).toBeNull();
  });
});

describe("cleanupSessionRecoveryFiles", () => {
  test("removes metadata file and wrapper script", () => {
    const metadataDir = join(TEST_BASE_DIR, SESSION_RECOVERY_DIR_NAME);
    mkdirSync(metadataDir, { recursive: true });

    const metadataPath = join(metadataDir, "my-session.json");
    const scriptPath = join(metadataDir, "my-session.sh");

    writeFileSync(metadataPath, "{}");
    writeFileSync(scriptPath, "#!/bin/bash");

    expect(existsSync(metadataPath)).toBe(true);
    expect(existsSync(scriptPath)).toBe(true);

    cleanupSessionRecoveryFiles("my-session", TEST_BASE_DIR);

    expect(existsSync(metadataPath)).toBe(false);
    expect(existsSync(scriptPath)).toBe(false);
  });

  test("does not throw when files do not exist", () => {
    expect(() => cleanupSessionRecoveryFiles("nonexistent", TEST_BASE_DIR)).not.toThrow();
  });

  test("removes only the target files, leaving others", () => {
    const metadataDir = join(TEST_BASE_DIR, SESSION_RECOVERY_DIR_NAME);
    mkdirSync(metadataDir, { recursive: true });

    writeFileSync(join(metadataDir, "other-session.json"), "{}");
    writeFileSync(join(metadataDir, "my-session.json"), "{}");

    cleanupSessionRecoveryFiles("my-session", TEST_BASE_DIR);

    expect(existsSync(join(metadataDir, "other-session.json"))).toBe(true);
    expect(existsSync(join(metadataDir, "my-session.json"))).toBe(false);
  });
});
