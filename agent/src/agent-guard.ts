import { ALL_INTERFACES_HOST, isLoopbackHost, LOOPBACK_HOST } from "@agent-town/shared";
import { guardRequest } from "@agent-town/shared/request-guard";

/** Upload is the one endpoint that takes multipart/form-data instead of JSON. */
export const AGENT_MULTIPART_PATHS = ["/api/upload"] as const;

export interface AgentGuardOptions {
  token: string;
  /** Browsers never talk to the agent directly, so this is empty unless configured. */
  allowedOrigins: readonly string[];
}

/** API and terminal routes need the token; `/` stays open as a tunnel health check. */
export function isAgentProtectedPath(pathname: string): boolean {
  return pathname.startsWith("/api/") || pathname.startsWith("/ws/");
}

/**
 * Guard a request to the agent. Only the server and local hooks call it,
 * so any browser Origin not explicitly allowlisted is rejected.
 * Returns an error response, or null when the request may proceed.
 */
export function guardAgentRequest(req: Request, opts: AgentGuardOptions): Response | null {
  if (!isAgentProtectedPath(new URL(req.url).pathname)) return null;
  return guardRequest(req, {
    token: opts.token,
    allowedOrigins: opts.allowedOrigins,
    allowSameOrigin: false,
    multipartPaths: AGENT_MULTIPART_PATHS,
  });
}

/**
 * Interface the agent binds to: `AGENT_TOWN_TERMINAL_HOST` if set; otherwise
 * loopback when the server is on this machine (or reached via an SSH tunnel),
 * and all interfaces when the server is elsewhere on the LAN and must dial in.
 */
export function resolveAgentBindHost(serverUrl: string, explicitHost: string | undefined): string {
  if (explicitHost) return explicitHost;
  return isLoopbackHost(new URL(serverUrl).hostname) ? LOOPBACK_HOST : ALL_INTERFACES_HOST;
}
