import type { SessionInfo } from "@agent-town/shared";
import { createLogger } from "@agent-town/shared";
import { getAllProviders } from "./providers/registry";

// Re-export parseClaudeSession for tests that use parseSession directly
export { parseClaudeSession as parseSession } from "./providers/claude-code/session-discovery";

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
