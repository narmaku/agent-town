import { type AgentType, createLogger, type SessionMessagesResponse, truncateId } from "@agent-town/shared";
import { getProvider } from "./providers/registry";

const log = createLogger("session-messages");

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

// Re-export for tests and other consumers
export {
  type ClaudeMessageEntry as JsonlEntry,
  formatClaudeEntry as formatEntry,
} from "./providers/claude-code/message-parser";
