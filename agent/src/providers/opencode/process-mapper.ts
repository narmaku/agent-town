/**
 * Extract session ID from OpenCode command args.
 * OpenCode uses `--session <id>` or `-s <id>`.
 */
export function extractOpenCodeSessionIdFromArgs(args: string): string | undefined {
  const match = args.match(/(?:--session|-s)\s+(\S+)/);
  return match?.[1];
}
