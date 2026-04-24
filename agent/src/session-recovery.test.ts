import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  buildWrapperScript,
  cleanupRecoveryBySessionId,
  cleanupSessionRecoveryFiles,
  readSessionMetadata,
  SESSION_RECOVERY_DIR_NAME,
  type SessionMetadata,
  writeSessionMetadata,
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
    expect(matches?.length).toBeGreaterThanOrEqual(2);
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
    expect(execMatches?.length).toBe(2);
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

  test("escapes model names containing special characters", () => {
    const script = buildWrapperScript({
      muxSessionName: "my-session",
      projectDir: "/home/user/project",
      model: "model with spaces",
      baseDir: TEST_BASE_DIR,
    });

    // shellEscape should wrap the model name in single quotes
    expect(script).toContain("--model 'model with spaces'");
  });

  test("escapes project dir containing single quotes", () => {
    const script = buildWrapperScript({
      muxSessionName: "my-session",
      projectDir: "/home/user/it's a project",
      baseDir: TEST_BASE_DIR,
    });

    // shellEscape replaces ' with '\'' for safe embedding
    expect(script).toContain("'/home/user/it'\\''s a project'");
  });

  test("handles empty string project dir", () => {
    const script = buildWrapperScript({
      muxSessionName: "my-session",
      projectDir: "",
      baseDir: TEST_BASE_DIR,
    });

    // shellEscape converts empty string to ''
    expect(script).toContain("cd ''");
  });

  test("includes set -euo pipefail for safety", () => {
    const script = buildWrapperScript({
      muxSessionName: "my-session",
      projectDir: "/tmp",
      baseDir: TEST_BASE_DIR,
    });

    expect(script).toContain("set -euo pipefail");
  });

  test("includes mux session name as a comment for debugging", () => {
    const script = buildWrapperScript({
      muxSessionName: "debug-session-42",
      projectDir: "/tmp",
      baseDir: TEST_BASE_DIR,
    });

    expect(script).toContain("# Mux session: debug-session-42");
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
    expect(result?.sessionId).toBe("abc-123");
    expect(result?.agentType).toBe("claude-code");
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

  test("returns null when sessionId is not a string", () => {
    const metadataDir = join(TEST_BASE_DIR, SESSION_RECOVERY_DIR_NAME);
    mkdirSync(metadataDir, { recursive: true });
    writeFileSync(join(metadataDir, "numeric-id.json"), JSON.stringify({ sessionId: 12345 }));

    const result = readSessionMetadata("numeric-id", TEST_BASE_DIR);
    expect(result).toBeNull();
  });

  test("returns null when sessionId is an empty string", () => {
    const metadataDir = join(TEST_BASE_DIR, SESSION_RECOVERY_DIR_NAME);
    mkdirSync(metadataDir, { recursive: true });
    writeFileSync(join(metadataDir, "empty-id.json"), JSON.stringify({ sessionId: "" }));

    const result = readSessionMetadata("empty-id", TEST_BASE_DIR);
    expect(result).toBeNull();
  });

  test("returns null when file is empty", () => {
    const metadataDir = join(TEST_BASE_DIR, SESSION_RECOVERY_DIR_NAME);
    mkdirSync(metadataDir, { recursive: true });
    writeFileSync(join(metadataDir, "empty.json"), "");

    const result = readSessionMetadata("empty", TEST_BASE_DIR);
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

  test("handles case where only metadata file exists (no script)", () => {
    const metadataDir = join(TEST_BASE_DIR, SESSION_RECOVERY_DIR_NAME);
    mkdirSync(metadataDir, { recursive: true });

    writeFileSync(join(metadataDir, "partial.json"), "{}");
    // No .sh file

    expect(() => cleanupSessionRecoveryFiles("partial", TEST_BASE_DIR)).not.toThrow();
    expect(existsSync(join(metadataDir, "partial.json"))).toBe(false);
  });

  test("handles case where only script file exists (no metadata)", () => {
    const metadataDir = join(TEST_BASE_DIR, SESSION_RECOVERY_DIR_NAME);
    mkdirSync(metadataDir, { recursive: true });

    writeFileSync(join(metadataDir, "script-only.sh"), "#!/bin/bash");
    // No .json file

    expect(() => cleanupSessionRecoveryFiles("script-only", TEST_BASE_DIR)).not.toThrow();
    expect(existsSync(join(metadataDir, "script-only.sh"))).toBe(false);
  });
});

describe("cleanupRecoveryBySessionId", () => {
  test("finds and removes recovery files matching the session ID", () => {
    const metadataDir = join(TEST_BASE_DIR, SESSION_RECOVERY_DIR_NAME);
    mkdirSync(metadataDir, { recursive: true });

    const metadata: SessionMetadata = {
      sessionId: "target-session-id",
      agentType: "claude-code",
      projectDir: "/tmp",
      autonomous: false,
      createdAt: new Date().toISOString(),
    };
    writeFileSync(join(metadataDir, "mux-name.json"), JSON.stringify(metadata));
    writeFileSync(join(metadataDir, "mux-name.sh"), "#!/bin/bash");

    cleanupRecoveryBySessionId("target-session-id", TEST_BASE_DIR);

    expect(existsSync(join(metadataDir, "mux-name.json"))).toBe(false);
    expect(existsSync(join(metadataDir, "mux-name.sh"))).toBe(false);
  });

  test("does not remove files for other session IDs", () => {
    const metadataDir = join(TEST_BASE_DIR, SESSION_RECOVERY_DIR_NAME);
    mkdirSync(metadataDir, { recursive: true });

    const metadata1: SessionMetadata = {
      sessionId: "session-a",
      agentType: "claude-code",
      projectDir: "/tmp",
      autonomous: false,
      createdAt: new Date().toISOString(),
    };
    const metadata2: SessionMetadata = {
      sessionId: "session-b",
      agentType: "claude-code",
      projectDir: "/tmp",
      autonomous: false,
      createdAt: new Date().toISOString(),
    };
    writeFileSync(join(metadataDir, "mux-a.json"), JSON.stringify(metadata1));
    writeFileSync(join(metadataDir, "mux-b.json"), JSON.stringify(metadata2));

    cleanupRecoveryBySessionId("session-a", TEST_BASE_DIR);

    expect(existsSync(join(metadataDir, "mux-a.json"))).toBe(false);
    expect(existsSync(join(metadataDir, "mux-b.json"))).toBe(true);
  });

  test("does not throw when directory does not exist", () => {
    expect(() => cleanupRecoveryBySessionId("nonexistent", "/tmp/does-not-exist")).not.toThrow();
  });

  test("skips corrupted JSON files without crashing", () => {
    const metadataDir = join(TEST_BASE_DIR, SESSION_RECOVERY_DIR_NAME);
    mkdirSync(metadataDir, { recursive: true });

    // Write a corrupt JSON file
    writeFileSync(join(metadataDir, "corrupt.json"), "not valid json {{{");
    // Write a valid one after it
    const validMetadata: SessionMetadata = {
      sessionId: "valid-session",
      agentType: "claude-code",
      projectDir: "/tmp",
      autonomous: false,
      createdAt: new Date().toISOString(),
    };
    writeFileSync(join(metadataDir, "valid.json"), JSON.stringify(validMetadata));

    // Should not throw despite the corrupt file
    expect(() => cleanupRecoveryBySessionId("valid-session", TEST_BASE_DIR)).not.toThrow();
    // The valid matching file should be cleaned up
    expect(existsSync(join(metadataDir, "valid.json"))).toBe(false);
    // The corrupt file should remain (not matching, not deleted)
    expect(existsSync(join(metadataDir, "corrupt.json"))).toBe(true);
  });

  test("does not remove non-JSON files during scan", () => {
    const metadataDir = join(TEST_BASE_DIR, SESSION_RECOVERY_DIR_NAME);
    mkdirSync(metadataDir, { recursive: true });

    writeFileSync(join(metadataDir, "script.sh"), "#!/bin/bash");
    writeFileSync(join(metadataDir, "notes.txt"), "some notes");

    expect(() => cleanupRecoveryBySessionId("any-id", TEST_BASE_DIR)).not.toThrow();
    // Non-JSON files should be untouched
    expect(existsSync(join(metadataDir, "script.sh"))).toBe(true);
    expect(existsSync(join(metadataDir, "notes.txt"))).toBe(true);
  });

  test("handles empty directory gracefully", () => {
    const metadataDir = join(TEST_BASE_DIR, SESSION_RECOVERY_DIR_NAME);
    mkdirSync(metadataDir, { recursive: true });

    expect(() => cleanupRecoveryBySessionId("any-id", TEST_BASE_DIR)).not.toThrow();
  });
});

describe("writeWrapperScript", () => {
  // Import the async version
  const { writeWrapperScript } = require("./session-recovery") as typeof import("./session-recovery");

  test("writes an executable script file to disk", async () => {
    const scriptPath = await writeWrapperScript(
      "test-session",
      {
        muxSessionName: "test-session",
        projectDir: "/home/user/project",
        baseDir: TEST_BASE_DIR,
      },
      TEST_BASE_DIR,
    );

    expect(existsSync(scriptPath)).toBe(true);
    expect(scriptPath).toContain("test-session.sh");

    const content = readFileSync(scriptPath, "utf-8");
    expect(content).toContain("#!/usr/bin/env bash");
    expect(content).toContain("exec claude");
  });

  test("creates the script with executable permissions", async () => {
    const scriptPath = await writeWrapperScript(
      "exec-test",
      {
        muxSessionName: "exec-test",
        projectDir: "/tmp",
        baseDir: TEST_BASE_DIR,
      },
      TEST_BASE_DIR,
    );

    const { statSync } = await import("node:fs");
    const stats = statSync(scriptPath);
    // Check that at least the owner execute bit is set (0o100)
    expect(stats.mode & 0o100).toBe(0o100);
  });

  test("creates the directory if it does not exist", async () => {
    const nestedDir = join(TEST_BASE_DIR, "deep", "nested");

    const scriptPath = await writeWrapperScript(
      "nested-session",
      {
        muxSessionName: "nested-session",
        projectDir: "/tmp",
        baseDir: nestedDir,
      },
      nestedDir,
    );

    expect(existsSync(scriptPath)).toBe(true);
  });
});

describe("end-to-end recovery flow", () => {
  test("wrapper script can resume a session after metadata is written", () => {
    // 1. Simulate: session is discovered and metadata is written
    const metadata: SessionMetadata = {
      sessionId: "550e8400-e29b-41d4-a716-446655440000",
      agentType: "claude-code",
      projectDir: "/home/user/project",
      autonomous: true,
      model: "claude-opus-4-6",
      createdAt: "2026-04-24T10:00:00.000Z",
    };
    writeSessionMetadata("recovery-session", metadata, TEST_BASE_DIR);

    // 2. Verify: metadata can be read back
    const readBack = readSessionMetadata("recovery-session", TEST_BASE_DIR);
    expect(readBack).not.toBeNull();
    expect(readBack?.sessionId).toBe("550e8400-e29b-41d4-a716-446655440000");

    // 3. Verify: wrapper script references the metadata file
    const script = buildWrapperScript({
      muxSessionName: "recovery-session",
      projectDir: "/home/user/project",
      model: "claude-opus-4-6",
      autonomous: true,
      baseDir: TEST_BASE_DIR,
    });
    const metadataPath = join(TEST_BASE_DIR, SESSION_RECOVERY_DIR_NAME, "recovery-session.json");
    expect(script).toContain(metadataPath);
    expect(script).toContain("--resume");
    expect(script).toContain("--dangerously-skip-permissions");
    expect(script).toContain("--model claude-opus-4-6");
  });

  test("cleanup removes both metadata and script after session delete", () => {
    // 1. Write metadata and script
    const metadata: SessionMetadata = {
      sessionId: "session-to-delete",
      agentType: "claude-code",
      projectDir: "/tmp",
      autonomous: false,
      createdAt: new Date().toISOString(),
    };
    writeSessionMetadata("delete-test", metadata, TEST_BASE_DIR);

    const metadataDir = join(TEST_BASE_DIR, SESSION_RECOVERY_DIR_NAME);
    writeFileSync(join(metadataDir, "delete-test.sh"), "#!/bin/bash");

    // 2. Verify files exist
    expect(existsSync(join(metadataDir, "delete-test.json"))).toBe(true);
    expect(existsSync(join(metadataDir, "delete-test.sh"))).toBe(true);

    // 3. Clean up by session ID (as delete endpoint would)
    cleanupRecoveryBySessionId("session-to-delete", TEST_BASE_DIR);

    // 4. Verify files are removed
    expect(existsSync(join(metadataDir, "delete-test.json"))).toBe(false);
    expect(existsSync(join(metadataDir, "delete-test.sh"))).toBe(false);
  });

  test("stale metadata without matching session does not affect new launches", () => {
    // Write stale metadata from a previous session
    const staleMetadata: SessionMetadata = {
      sessionId: "old-session-id",
      agentType: "claude-code",
      projectDir: "/tmp",
      autonomous: false,
      createdAt: "2025-01-01T00:00:00.000Z",
    };
    writeSessionMetadata("stale-session", staleMetadata, TEST_BASE_DIR);

    // Read it back - it's still valid (wrapper will try to resume)
    const readBack = readSessionMetadata("stale-session", TEST_BASE_DIR);
    expect(readBack).not.toBeNull();
    expect(readBack?.sessionId).toBe("old-session-id");

    // Fresh wrapper for a different session works independently
    const script = buildWrapperScript({
      muxSessionName: "new-session",
      projectDir: "/tmp",
      baseDir: TEST_BASE_DIR,
    });
    expect(script).not.toContain("old-session-id");
  });
});
