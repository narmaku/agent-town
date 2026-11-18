// Resolves the directory where agent-town persists local state
// (settings, session names, remote nodes, rename map, mux associations).
//
// Kept out of the package index because it depends on node:os, and the
// index is also bundled into the browser dashboard.

import { homedir } from "node:os";
import { join } from "node:path";

export const DATA_DIR_ENV_VAR = "AGENT_TOWN_DATA_DIR";
export const DEFAULT_DATA_DIR_NAME = ".agent-town";

/**
 * Returns `$AGENT_TOWN_DATA_DIR` when set to a non-blank value,
 * otherwise `~/.agent-town`.
 */
export function resolveDataDir(env: Record<string, string | undefined> = process.env): string {
  const override = env[DATA_DIR_ENV_VAR]?.trim();
  return override ? override : join(homedir(), DEFAULT_DATA_DIR_NAME);
}
