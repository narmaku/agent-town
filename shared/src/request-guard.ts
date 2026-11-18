/**
 * Request guards shared by the server and the agent.
 *
 * Every API / WebSocket request must pass three checks, in this order:
 *   1. Origin  — a browser-supplied Origin header must be on the allowlist
 *                (blocks cross-site WebSocket hijacking and CSRF).
 *   2. Token   — the shared secret must be presented, as an
 *                `Authorization: Bearer <token>` header or, for WebSocket
 *                upgrades only, a `?token=` query parameter.
 *   3. Body    — POST/PUT/PATCH bodies must be `application/json` (or
 *                `multipart/form-data` on upload paths), so a cross-site
 *                "simple" form post can never reach a handler.
 */
import { createHash, timingSafeEqual } from "node:crypto";

import { createLogger } from "./logger";

const log = createLogger("guard");

export const TOKEN_QUERY_PARAM = "token";
const BEARER_PREFIX = "Bearer ";
const JSON_CONTENT_TYPE = "application/json";
const MULTIPART_CONTENT_TYPE = "multipart/form-data";
const BODY_METHODS = new Set(["POST", "PUT", "PATCH"]);

export interface RequestGuardOptions {
  /** Shared secret every request must present. */
  token: string;
  /** Extra browser origins allowed to call this service (e.g. "http://localhost:5173"). */
  allowedOrigins: readonly string[];
  /** Allow requests whose Origin matches the Host they were sent to (the dashboard itself). */
  allowSameOrigin: boolean;
  /** Paths whose POST body is multipart/form-data instead of JSON. */
  multipartPaths?: readonly string[];
}

/** Compare two secrets in constant time, regardless of their lengths. */
export function tokensMatch(presented: string, expected: string): boolean {
  const a = createHash("sha256").update(presented).digest();
  const b = createHash("sha256").update(expected).digest();
  return timingSafeEqual(a, b) && expected.length > 0;
}

function isWebSocketUpgrade(req: Request): boolean {
  return req.headers.get("upgrade")?.toLowerCase() === "websocket";
}

/**
 * Read the token a request presents. The query parameter is only honoured on
 * WebSocket upgrades, because browsers cannot set headers on `new WebSocket()`.
 */
export function extractToken(req: Request): string | null {
  const header = req.headers.get("authorization");
  if (header?.startsWith(BEARER_PREFIX)) {
    return header.slice(BEARER_PREFIX.length).trim();
  }
  if (isWebSocketUpgrade(req)) {
    return new URL(req.url).searchParams.get(TOKEN_QUERY_PARAM);
  }
  return null;
}

/**
 * Requests without an Origin header come from non-browser clients (the agent,
 * curl, hooks) and are allowed here; they still need the token.
 */
export function isOriginAllowed(
  req: Request,
  opts: Pick<RequestGuardOptions, "allowedOrigins" | "allowSameOrigin">,
): boolean {
  const origin = req.headers.get("origin");
  if (origin === null) return true;
  if (opts.allowedOrigins.includes(origin)) return true;
  if (!opts.allowSameOrigin) return false;
  const host = req.headers.get("host");
  if (!host) return false;
  return origin === `http://${host}` || origin === `https://${host}`;
}

function mediaType(req: Request): string {
  return (req.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
}

/** Body-carrying methods must declare JSON (or multipart on upload paths). */
export function hasAllowedContentType(req: Request, multipartPaths: readonly string[] = []): boolean {
  if (!BODY_METHODS.has(req.method)) return true;
  const expected = multipartPaths.includes(new URL(req.url).pathname) ? MULTIPART_CONTENT_TYPE : JSON_CONTENT_TYPE;
  return mediaType(req) === expected;
}

/** Run all guards. Returns an error response to send, or null when the request may proceed. */
export function guardRequest(req: Request, opts: RequestGuardOptions): Response | null {
  const { pathname } = new URL(req.url);

  if (!isOriginAllowed(req, opts)) {
    log.warn(`rejected ${req.method} ${pathname}: origin not allowed (${req.headers.get("origin")})`);
    return Response.json({ error: "Origin not allowed" }, { status: 403 });
  }

  const presented = extractToken(req);
  if (presented === null || !tokensMatch(presented, opts.token)) {
    log.warn(`rejected ${req.method} ${pathname}: missing or invalid token`);
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  if (!hasAllowedContentType(req, opts.multipartPaths)) {
    log.warn(`rejected ${req.method} ${pathname}: unsupported content-type (${req.headers.get("content-type")})`);
    return Response.json({ error: "Unsupported Media Type" }, { status: 415 });
  }

  return null;
}

/** Parse a comma-separated origin list (e.g. from an env var), dropping invalid entries. */
export function parseOriginList(value: string | undefined): string[] {
  if (!value) return [];
  const origins: string[] = [];
  for (const raw of value.split(",")) {
    const entry = raw.trim();
    if (!entry) continue;
    try {
      origins.push(new URL(entry).origin);
    } catch (err) {
      log.warn(`ignoring invalid allowed origin "${entry}": ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return origins;
}

/** Header object carrying the shared secret, for server↔agent calls. */
export function authHeaders(token: string): Record<string, string> {
  return { Authorization: `${BEARER_PREFIX}${token}` };
}
