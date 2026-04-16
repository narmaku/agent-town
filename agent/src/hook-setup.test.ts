import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildHookConfig, configureLocalHooks } from "./hook-setup";

const HOOK_EVENTS = [
  "PreToolUse",
  "PostToolUse",
  "PostToolUseFailure",
  "Notification",
  "Stop",
  "UserPromptSubmit",
  "SessionStart",
  "SessionEnd",
];

describe("buildHookConfig", () => {
  test("creates correct hook config for a given port", () => {
    const config = buildHookConfig(4681);

    for (const event of HOOK_EVENTS) {
      expect(config[event]).toBeDefined();
      expect(config[event]).toHaveLength(1);
      expect(config[event][0].matcher).toBe("");
      expect(config[event][0].hooks).toHaveLength(1);
      expect(config[event][0].hooks[0].type).toBe("command");
      expect(config[event][0].hooks[0].command).toBe(
        "curl -s -X POST http://localhost:4681/api/hook-event -H 'Content-Type: application/json' -d @-",
      );
    }
  });

  test("includes all expected hook events", () => {
    const config = buildHookConfig(4681);
    const events = Object.keys(config);
    expect(events).toEqual(HOOK_EVENTS);
  });

  test("uses the provided port number", () => {
    const config = buildHookConfig(9999);
    const command = config.PreToolUse[0].hooks[0].command;
    expect(command).toContain("http://localhost:9999/api/hook-event");
  });
});

describe("configureLocalHooks", () => {
  let tmpDir: string;
  let settingsPath: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "hook-setup-test-"));
    settingsPath = join(tmpDir, ".claude", "settings.json");
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test("creates settings file when none exists", () => {
    configureLocalHooks(4681, settingsPath);

    const content = JSON.parse(readFileSync(settingsPath, "utf-8"));
    expect(content.hooks).toBeDefined();
    expect(Object.keys(content.hooks)).toEqual(HOOK_EVENTS);
  });

  test("preserves existing non-hook settings", () => {
    const existingSettings = {
      model: "claude-sonnet-4-20250514",
      permissions: { allow: ["Read", "Write"] },
      theme: "dark",
    };

    // Create the directory and file
    const { mkdirSync } = require("node:fs");
    mkdirSync(join(tmpDir, ".claude"), { recursive: true });
    writeFileSync(settingsPath, JSON.stringify(existingSettings, null, 2));

    configureLocalHooks(4681, settingsPath);

    const content = JSON.parse(readFileSync(settingsPath, "utf-8"));
    expect(content.model).toBe("claude-sonnet-4-20250514");
    expect(content.permissions).toEqual({ allow: ["Read", "Write"] });
    expect(content.theme).toBe("dark");
    expect(content.hooks).toBeDefined();
  });

  test("overwrites existing hooks with correct format", () => {
    const existingSettings = {
      model: "claude-sonnet-4-20250514",
      hooks: {
        PreToolUse: [
          {
            matcher: "",
            hooks: [{ type: "http", url: "http://wrong:1234/bad" }],
          },
        ],
      },
    };

    const { mkdirSync } = require("node:fs");
    mkdirSync(join(tmpDir, ".claude"), { recursive: true });
    writeFileSync(settingsPath, JSON.stringify(existingSettings, null, 2));

    configureLocalHooks(4681, settingsPath);

    const content = JSON.parse(readFileSync(settingsPath, "utf-8"));
    expect(content.model).toBe("claude-sonnet-4-20250514");

    // Should have all hook events, not just the old PreToolUse
    expect(Object.keys(content.hooks)).toEqual(HOOK_EVENTS);

    // Should use "command" type, not "http"
    const preToolUse = content.hooks.PreToolUse[0];
    expect(preToolUse.hooks[0].type).toBe("command");
    expect(preToolUse.hooks[0].command).toContain("curl -s -X POST http://localhost:4681/api/hook-event");
  });

  test("skips write when hooks are already correct (idempotent)", () => {
    const { mkdirSync, statSync } = require("node:fs");
    mkdirSync(join(tmpDir, ".claude"), { recursive: true });

    // First call: creates the file
    configureLocalHooks(4681, settingsPath);
    const firstStat = statSync(settingsPath);
    const firstMtime = firstStat.mtimeMs;

    // Small delay to ensure mtime would differ on write
    const startTime = Date.now();
    while (Date.now() - startTime < 10) {
      /* busy wait */
    }

    // Second call: should skip write
    configureLocalHooks(4681, settingsPath);
    const secondStat = statSync(settingsPath);
    const secondMtime = secondStat.mtimeMs;

    // mtime should not change because write was skipped
    expect(secondMtime).toBe(firstMtime);
  });

  test("creates parent directories when they do not exist", () => {
    const deepPath = join(tmpDir, "a", "b", "c", "settings.json");

    configureLocalHooks(4681, deepPath);

    const content = JSON.parse(readFileSync(deepPath, "utf-8"));
    expect(content.hooks).toBeDefined();
  });

  test("handles malformed settings.json gracefully", () => {
    const { mkdirSync } = require("node:fs");
    mkdirSync(join(tmpDir, ".claude"), { recursive: true });
    writeFileSync(settingsPath, "this is not json {{{");

    // Should not throw — should overwrite with fresh settings
    configureLocalHooks(4681, settingsPath);

    const content = JSON.parse(readFileSync(settingsPath, "utf-8"));
    expect(content.hooks).toBeDefined();
    expect(Object.keys(content.hooks)).toEqual(HOOK_EVENTS);
  });
});
