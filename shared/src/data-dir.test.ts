import { describe, expect, test } from "bun:test";
import { homedir } from "node:os";
import { join } from "node:path";

import { DATA_DIR_ENV_VAR, resolveDataDir } from "./data-dir";

describe("resolveDataDir", () => {
  test("defaults to ~/.agent-town when the env var is unset", () => {
    expect(resolveDataDir({})).toBe(join(homedir(), ".agent-town"));
  });

  test("uses AGENT_TOWN_DATA_DIR when set", () => {
    expect(resolveDataDir({ [DATA_DIR_ENV_VAR]: "/tmp/agent-town-custom" })).toBe("/tmp/agent-town-custom");
  });

  test("ignores a blank AGENT_TOWN_DATA_DIR", () => {
    expect(resolveDataDir({ [DATA_DIR_ENV_VAR]: "   " })).toBe(join(homedir(), ".agent-town"));
  });

  test("the test preload points the data dir away from the real home directory", () => {
    expect(resolveDataDir()).not.toBe(join(homedir(), ".agent-town"));
  });
});
