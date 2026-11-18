import type { AgentType } from "@agent-town/shared";

/** One session whose messages contain a search query. */
export interface SearchMessageResult {
  sessionId: string;
  agentType: AgentType;
  snippet: string;
  matchCount: number;
}

const SEARCH_SNIPPET_LENGTH = 120;

/** A single-line excerpt of `text` centred on the match at `index`. */
export function extractSnippet(text: string, index: number, queryLength: number): string {
  const half = Math.floor((SEARCH_SNIPPET_LENGTH - queryLength) / 2);
  const start = Math.max(0, index - half);
  const end = Math.min(text.length, index + queryLength + half);
  const excerpt = text.slice(start, end).replace(/\s*\n\s*/g, " ");
  return `${start > 0 ? "…" : ""}${excerpt}${end < text.length ? "…" : ""}`;
}

/**
 * Count how many of `texts` contain `query` (already lower-cased), with a
 * snippet from the first match.
 */
export function matchTexts(texts: Iterable<string>, query: string): { matchCount: number; snippet: string } {
  let matchCount = 0;
  let snippet = "";
  for (const text of texts) {
    const index = text.toLowerCase().indexOf(query);
    if (index < 0) continue;
    matchCount++;
    if (!snippet) snippet = extractSnippet(text, index, query.length);
  }
  return { matchCount, snippet };
}

/** Plain text of message content that is a string or an array of `{ text }` blocks. */
export function contentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((block) => (block && typeof block === "object" && "text" in block ? block.text : undefined))
    .filter((text): text is string => typeof text === "string")
    .join(" ");
}
