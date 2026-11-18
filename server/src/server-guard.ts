import { guardRequest } from "@agent-town/shared/request-guard";

/** Upload is the one endpoint that takes multipart/form-data instead of JSON. */
export const SERVER_MULTIPART_PATHS = ["/api/sessions/upload"] as const;

export interface ServerGuardOptions {
  token: string;
  allowedOrigins: readonly string[];
}

/** API and WebSocket routes need the token; the dashboard's static files do not. */
export function isProtectedPath(pathname: string): boolean {
  return pathname.startsWith("/api/") || pathname === "/ws" || pathname.startsWith("/ws/");
}

/**
 * Guard a request to the server. The dashboard is served from this origin,
 * so same-origin browser requests are allowed (they still need the token).
 * Returns an error response, or null when the request may proceed.
 */
export function guardServerRequest(req: Request, opts: ServerGuardOptions): Response | null {
  if (!isProtectedPath(new URL(req.url).pathname)) return null;
  return guardRequest(req, {
    token: opts.token,
    allowedOrigins: opts.allowedOrigins,
    allowSameOrigin: true,
    multipartPaths: SERVER_MULTIPART_PATHS,
  });
}
