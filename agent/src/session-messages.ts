import { readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { type AgentType, createLogger, type SessionMessagesResponse, truncateId } from "@agent-town/shared";
import { getAllProviders, getProvider } from "./providers/registry";

const log = createLogger("session-messages");

const CLAUDE_PROJECTS_DIR = join(homedir(), ".claude", "projects");
const GEMINI_TMP_DIR = join(homedir(), ".gemini", "tmp");

const SEARCH_SNIPPET_LENGTH = 120;
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

/** Result from searching session message content. */
export interface SearchMessageResult {
  sessionId: string;
  agentType: AgentType;
  snippet: string;
  matchCount: number;
}

/**
 * Search across ALL sessions' message content for a query string.
 * Case-insensitive substring match. Returns matching session IDs with snippets.
 */
export async function searchSessionMessages(
  query: string,
  limit: number = DEFAULT_SEARCH_LIMIT,
): Promise<SearchMessageResult[]> {
  const q = query.toLowerCase();
  const results: SearchMessageResult[] = [];

  const providers = getAllProviders();

  for (const provider of providers) {
    try {
      if (provider.type === "claude-code") {
        const claudeResults = await searchClaudeJsonlFiles(q, limit - results.length);
        results.push(...claudeResults);
      } else if (provider.type === "opencode") {
        const opencodeResults = await searchOpenCodeSQLite(q, limit - results.length);
        results.push(...opencodeResults);
      } else if (provider.type === "gemini-cli") {
        const geminiResults = await searchGeminiJsonFiles(q, limit - results.length);
        results.push(...geminiResults);
      }
    } catch (err) {
      log.debug(
        `searchSessionMessages: ${provider.type} search failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    if (results.length >= limit) break;
  }

  return results.slice(0, limit);
}

/**
 * Search Claude Code JSONL files for a query string in message content.
 */
async function searchClaudeJsonlFiles(query: string, maxResults: number): Promise<SearchMessageResult[]> {
  const results: SearchMessageResult[] = [];

  try {
    const projectDirs = await readdir(CLAUDE_PROJECTS_DIR);
    for (const dir of projectDirs) {
      if (results.length >= maxResults) break;

      const projectDir = join(CLAUDE_PROJECTS_DIR, dir);
      const dirStat = await stat(projectDir);
      if (!dirStat.isDirectory()) continue;

      const files = await readdir(projectDir);
      const jsonlFiles = files.filter((f) => f.endsWith(".jsonl"));

      for (const jsonlFile of jsonlFiles) {
        if (results.length >= maxResults) break;

        const jsonlPath = join(projectDir, jsonlFile);
        try {
          const text = await Bun.file(jsonlPath).text();
          const lowerText = text.toLowerCase();

          if (!lowerText.includes(query)) continue;

          // Count matches and extract snippet
          const lines = text.split("\n");
          let matchCount = 0;
          let snippet = "";
          let sessionId = "";

          for (const line of lines) {
            if (!line.trim()) continue;
            const lowerLine = line.toLowerCase();
            if (!lowerLine.includes(query) && !sessionId) {
              // Still try to extract sessionId from non-matching lines
              try {
                const entry = JSON.parse(line) as { sessionId?: string };
                if (entry.sessionId) sessionId = entry.sessionId;
              } catch (_err) {
                // skip
              }
              continue;
            }

            try {
              const entry = JSON.parse(line) as {
                sessionId?: string;
                message?: { content?: unknown };
              };
              if (entry.sessionId) sessionId = entry.sessionId;

              const content = extractTextFromContent(entry.message?.content);
              const lowerContent = content.toLowerCase();
              const idx = lowerContent.indexOf(query);
              if (idx >= 0) {
                matchCount++;
                if (!snippet) {
                  snippet = extractSnippet(content, idx, query.length);
                }
              }
            } catch (_err) {
              // skip malformed line
            }
          }

          if (sessionId && matchCount > 0) {
            results.push({
              sessionId,
              agentType: "claude-code",
              snippet,
              matchCount,
            });
          }
        } catch (err) {
          log.debug(
            `searchClaudeJsonlFiles: failed to read ${jsonlPath}: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
    }
  } catch (err) {
    log.debug(`searchClaudeJsonlFiles: ${err instanceof Error ? err.message : String(err)}`);
  }

  return results;
}

/**
 * Search OpenCode SQLite database for a query string in message parts.
 */
async function searchOpenCodeSQLite(query: string, maxResults: number): Promise<SearchMessageResult[]> {
  const results: SearchMessageResult[] = [];

  try {
    const { Database } = await import("bun:sqlite");
    const { OPENCODE_DB_PATH } = await import("./providers/opencode/session-discovery");

    const db = new Database(OPENCODE_DB_PATH, { readonly: true });

    // Search in part text content using LIKE
    const rows = db
      .query<{ session_id: string; text_content: string; match_count: number }, [string, number]>(
        `SELECT m.session_id,
                (SELECT p2.data FROM part p2
                 WHERE p2.message_id = m.id
                   AND p2.data LIKE '%' || ?1 || '%'
                 LIMIT 1) as text_content,
                COUNT(*) as match_count
         FROM message m
         JOIN part p ON p.message_id = m.id
         WHERE p.data LIKE '%' || ?1 || '%'
         GROUP BY m.session_id
         ORDER BY match_count DESC
         LIMIT ?2`,
      )
      .all(query, maxResults);

    for (const row of rows) {
      let snippet = "";
      if (row.text_content) {
        try {
          const partData = JSON.parse(row.text_content) as { text?: string };
          if (partData.text) {
            const lowerText = partData.text.toLowerCase();
            const idx = lowerText.indexOf(query);
            if (idx >= 0) {
              snippet = extractSnippet(partData.text, idx, query.length);
            }
          }
        } catch (_err) {
          // skip
        }
      }

      results.push({
        sessionId: row.session_id,
        agentType: "opencode",
        snippet,
        matchCount: row.match_count,
      });
    }

    db.close();
  } catch (err) {
    log.debug(`searchOpenCodeSQLite: ${err instanceof Error ? err.message : String(err)}`);
  }

  return results;
}

/**
 * Search Gemini CLI JSON session files for a query string in message content.
 */
async function searchGeminiJsonFiles(query: string, maxResults: number): Promise<SearchMessageResult[]> {
  const results: SearchMessageResult[] = [];

  try {
    const tmpDirs = await readdir(GEMINI_TMP_DIR);

    for (const projectHash of tmpDirs) {
      if (results.length >= maxResults) break;

      const chatsDir = join(GEMINI_TMP_DIR, projectHash, "chats");
      let chatFiles: string[];
      try {
        chatFiles = await readdir(chatsDir);
      } catch (_err) {
        continue;
      }

      for (const chatFile of chatFiles) {
        if (results.length >= maxResults) break;
        if (!chatFile.endsWith(".json")) continue;

        const filePath = join(chatsDir, chatFile);
        try {
          const text = await Bun.file(filePath).text();
          if (!text.toLowerCase().includes(query)) continue;

          const data = JSON.parse(text) as {
            sessionId?: string;
            messages?: Array<{ content?: unknown }>;
          };
          if (!data.sessionId || !data.messages) continue;

          let matchCount = 0;
          let snippet = "";

          for (const msg of data.messages) {
            const content = extractTextFromContent(msg.content);
            const lowerContent = content.toLowerCase();
            const idx = lowerContent.indexOf(query);
            if (idx >= 0) {
              matchCount++;
              if (!snippet) {
                snippet = extractSnippet(content, idx, query.length);
              }
            }
          }

          if (matchCount > 0) {
            results.push({
              sessionId: data.sessionId,
              agentType: "gemini-cli",
              snippet,
              matchCount,
            });
          }
        } catch (_err) {
          // skip malformed files
        }
      }
    }
  } catch (err) {
    log.debug(`searchGeminiJsonFiles: ${err instanceof Error ? err.message : String(err)}`);
  }

  return results;
}

/** Extract plain text from message content (string or array of content blocks). */
function extractTextFromContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const block of content) {
      const b = block as Record<string, unknown>;
      if (typeof b.text === "string") parts.push(b.text);
    }
    return parts.join(" ");
  }
  return "";
}

/** Extract a snippet around a match position. */
function extractSnippet(text: string, matchIndex: number, matchLength: number): string {
  const halfWindow = Math.floor((SEARCH_SNIPPET_LENGTH - matchLength) / 2);
  const start = Math.max(0, matchIndex - halfWindow);
  const end = Math.min(text.length, matchIndex + matchLength + halfWindow);
  let snippet = text.slice(start, end).replace(/\n/g, " ").trim();
  if (start > 0) snippet = `...${snippet}`;
  if (end < text.length) snippet = `${snippet}...`;
  return snippet;
}

// Re-export for tests and other consumers
export {
  type ClaudeMessageEntry as JsonlEntry,
  formatClaudeEntry as formatEntry,
} from "./providers/claude-code/message-parser";
