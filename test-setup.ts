// Preloaded by `bun test` (see bunfig.toml) before any test file is imported.
//
// Server and agent modules resolve their data directory at load time, so the
// override must be in place before they are imported. Pointing it at a
// throwaway directory keeps tests from overwriting the developer's real
// ~/.agent-town state (settings, session names, rename map, ...).

import { afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { DATA_DIR_ENV_VAR } from "@agent-town/shared/data-dir";

const testDataDir = mkdtempSync(join(tmpdir(), "agent-town-test-data-"));
process.env[DATA_DIR_ENV_VAR] = testDataDir;

afterAll(() => {
  rmSync(testDataDir, { recursive: true, force: true });
});
