import { LOOPBACK_HOST } from "./network";

/** Shell expression for the token file on a machine whose agent uses the default location. */
export const DEFAULT_TOKEN_FILE_SHELL_EXPR = '"$HOME/.agent-town/token"';

/**
 * Build the Claude Code hook command that POSTs the event JSON (stdin) to the
 * local agent. The token is read from disk when the hook runs, so the secret
 * itself is never written into ~/.claude/settings.json.
 *
 * @param port - agent port on this machine
 * @param tokenFileExpr - shell expression naming the token file (already quoted/escaped)
 */
export function buildHookCommand(port: number, tokenFileExpr: string = DEFAULT_TOKEN_FILE_SHELL_EXPR): string {
  return [
    "curl -s -X POST",
    `http://${LOOPBACK_HOST}:${port}/api/hook-event`,
    "-H 'Content-Type: application/json'",
    `-H "Authorization: Bearer $(cat ${tokenFileExpr})"`,
    "-d @-",
  ].join(" ");
}
