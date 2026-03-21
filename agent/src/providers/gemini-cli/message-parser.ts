import {
  createLogger,
  paginateFromEnd,
  type SessionMessage,
  type SessionMessagesResponse,
  truncateId,
} from "@agent-town/shared";
import type { GeminiMessage, GeminiSessionFile, GeminiToolCall } from "./session-discovery";
import { extractTextContent, findSessionFilePath } from "./session-discovery";

const log = createLogger("gemini:messages");

const TOOL_CONTENT_MAX_LENGTH = 2000;

/**
 * Convert a Gemini CLI message to the normalized SessionMessage format.
 *
 * Gemini messages have:
 * - type: "user" | "gemini" | "info"
 * - content: string (for gemini) or Array<{ text: string }> (for user)
 * - thoughts: Array<{ subject, description, timestamp }>
 * - toolCalls: Array of tool call objects with args and results
 * - model: model name (on gemini messages)
 * - tokens: token usage stats
 */
export function formatGeminiMessage(msg: GeminiMessage): SessionMessage {
  const role: "user" | "assistant" = msg.type === "user" ? "user" : "assistant";
  const textContent = extractTextContent(msg.content);

  let toolUse: { name: string; id: string; input?: string }[] | undefined;
  let toolResults: { toolUseId: string; content: string }[] | undefined;
  let thinking: string | undefined;

  // Parse tool calls
  if (msg.toolCalls && msg.toolCalls.length > 0) {
    const tools: { name: string; id: string; input?: string }[] = [];
    const results: { toolUseId: string; content: string }[] = [];

    for (const tc of msg.toolCalls) {
      const input = tc.args ? JSON.stringify(tc.args, null, 2).slice(0, TOOL_CONTENT_MAX_LENGTH) : undefined;
      tools.push({
        name: tc.displayName || tc.name,
        id: tc.id,
        input,
      });

      const resultText = extractToolCallResult(tc);
      if (resultText) {
        results.push({
          toolUseId: tc.id,
          content: resultText.slice(0, TOOL_CONTENT_MAX_LENGTH),
        });
      }
    }

    if (tools.length > 0) toolUse = tools;
    if (results.length > 0) toolResults = results;
  }

  // Parse thoughts/reasoning
  if (msg.thoughts && msg.thoughts.length > 0) {
    thinking = msg.thoughts.map((t) => `**${t.subject}**: ${t.description}`).join("\n\n");
  }

  return {
    role,
    timestamp: msg.timestamp,
    content: textContent,
    toolUse,
    toolResults,
    thinking,
    model: msg.model,
  };
}

function extractToolCallResult(tc: GeminiToolCall): string | undefined {
  // Check resultDisplay first (human-readable output)
  if (tc.resultDisplay) return tc.resultDisplay;

  // Check result array (structured response)
  if (tc.result && Array.isArray(tc.result)) {
    const outputs: string[] = [];
    for (const r of tc.result) {
      const fr = r as Record<string, unknown>;
      const funcResp = fr.functionResponse as { response?: { output?: string } } | undefined;
      if (funcResp?.response?.output) {
        outputs.push(funcResp.response.output);
      }
    }
    if (outputs.length > 0) return outputs.join("\n");
  }

  return undefined;
}

/**
 * Get paginated messages for a Gemini CLI session.
 * Reads the session JSON file directly.
 */
export async function getGeminiSessionMessages(
  sessionId: string,
  offset: number,
  limit: number,
): Promise<SessionMessagesResponse> {
  const filePath = await findSessionFilePath(sessionId);
  if (!filePath) {
    log.warn(`session not found: sessionId=${truncateId(sessionId)}`);
    throw new Error("Session not found");
  }

  const text = await Bun.file(filePath).text();
  const sessionData: GeminiSessionFile = JSON.parse(text);

  // Filter to user/gemini messages only (skip "info" messages)
  const entries = sessionData.messages.filter((m) => m.type === "user" || m.type === "gemini");

  const total = entries.length;
  const { slice, hasMore } = paginateFromEnd(entries, offset, limit);

  const messages = slice.map(formatGeminiMessage);

  log.debug(
    `getGeminiSessionMessages: session=${truncateId(sessionId)} total=${total} returned=${messages.length} offset=${offset}`,
  );
  return { messages, total, hasMore };
}
