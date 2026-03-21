/**
 * Extract session ID from Gemini CLI command args.
 * Gemini CLI uses `--resume <id>` or `-r <id>` to resume a session.
 * The session ID can be a UUID or a numeric index.
 */
export function extractGeminiSessionIdFromArgs(args: string): string | undefined {
  const match = args.match(/(?:--resume|-r)\s+(\S+)/);
  if (!match) return undefined;

  const value = match[1];
  // Filter out numeric indices (e.g. --resume 5) — only return UUIDs
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) {
    return value;
  }
  // Also accept short hash prefixes (8 hex chars) used in session filenames
  if (/^[0-9a-f]{8}$/i.test(value)) {
    return value;
  }
  return undefined;
}
