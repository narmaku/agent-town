import {
  type AgentType,
  createLogger,
  errorMessage,
  type SessionMessagesResponse,
  truncateId,
} from "@agent-town/shared";
import { getAllProviders, getProvider } from "./providers/registry";
import type { SearchMessageResult } from "./providers/search";

const log = createLogger("session-messages");

const DEFAULT_SEARCH_LIMIT = 50;

/**
 * Get paginated messages for a session.
 * Routes to the correct provider based on agentType.
 * Falls back to claude-code if no agentType specified.
 */
export async function getSessionMessages(
  sessionId: string,
  offset: number,
  limit: number,
  agentType?: AgentType,
): Promise<SessionMessagesResponse> {
  const type = agentType || "claude-code";
  const provider = getProvider(type);

  if (!provider) {
    log.warn(`no provider for agentType=${type}, session=${truncateId(sessionId)}`);
    throw new Error(`No provider available for agent type: ${type}`);
  }

  return provider.getSessionMessages(sessionId, offset, limit);
}

export type { SearchMessageResult } from "./providers/search";

/**
 * Search every provider's sessions for a query string (case-insensitive
 * substring match). Returns matching session IDs with snippets.
 */
export async function searchSessionMessages(
  query: string,
  limit: number = DEFAULT_SEARCH_LIMIT,
): Promise<SearchMessageResult[]> {
  const q = query.toLowerCase();
  const results: SearchMessageResult[] = [];
  for (const provider of getAllProviders()) {
    if (results.length >= limit) break;
    try {
      results.push(...(await provider.searchMessages(q, limit - results.length)));
    } catch (err) {
      log.debug(`search: ${provider.type} failed: ${errorMessage(err)}`);
    }
  }
  return results.slice(0, limit);
}

// Re-export for tests and other consumers
export {
  type ClaudeMessageEntry as JsonlEntry,
  formatClaudeEntry as formatEntry,
} from "./providers/claude-code/message-parser";
