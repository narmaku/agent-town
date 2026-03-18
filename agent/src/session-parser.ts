import { stat } from "node:fs/promises";
import type { SessionInfo } from "@agent-town/shared";
import { createLogger } from "@agent-town/shared";
import { parseClaudeSession } from "./providers/claude-code/session-discovery";
import { getAllProviders } from "./providers/registry";

/** Parse a single JSONL file into a SessionInfo. Used by tests. */
export async function parseSession(jsonlPath: string): Promise<SessionInfo | null> {
  const fileStat = await stat(jsonlPath);
  return parseClaudeSession(jsonlPath, fileStat.mtimeMs);
}

const log = createLogger("session-parser");

/**
 * Discover sessions from all registered providers.
 */
export async function discoverSessions(): Promise<SessionInfo[]> {
  const providers = getAllProviders();
  const results = await Promise.all(providers.map((p) => p.discoverSessions()));
  const allSessions = results.flat();
  log.debug(`discovered ${allSessions.length} sessions from ${providers.length} provider(s)`);
  return allSessions;
}
