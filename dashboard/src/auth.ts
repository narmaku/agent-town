/**
 * Dashboard access token.
 *
 * The server prints a login URL of the form `http://host:4680/#token=<secret>`.
 * The fragment never leaves the browser (it is not sent to the server or in
 * Referer headers); we read it once, keep the token in memory and in
 * sessionStorage (per-tab, cleared when the tab closes), and strip it from the URL.
 */
import { createBrowserLogger } from "./logger";

const logger = createBrowserLogger("auth");

const TOKEN_STORAGE_KEY = "agentTown:token";
const TOKEN_FRAGMENT_PARAM = "token";
const TOKEN_QUERY_PARAM = "token";
const BODY_METHODS = new Set(["POST", "PUT", "PATCH"]);

/** Fired on `window` when the server rejects the token, so the login screen can show. */
export const UNAUTHORIZED_EVENT = "agent-town:unauthorized";

let memoryToken: string | null = null;

/** Extract `token` from a URL fragment such as `#token=abc`. */
export function readTokenFromFragment(hash: string): string | null {
  const params = new URLSearchParams(hash.startsWith("#") ? hash.slice(1) : hash);
  const token = params.get(TOKEN_FRAGMENT_PARAM)?.trim();
  return token ? token : null;
}

export function getToken(): string | null {
  if (memoryToken) return memoryToken;
  try {
    memoryToken = sessionStorage.getItem(TOKEN_STORAGE_KEY);
  } catch (err) {
    logger.warn("could not read token from sessionStorage", err);
  }
  return memoryToken;
}

export function setToken(token: string): void {
  memoryToken = token;
  try {
    sessionStorage.setItem(TOKEN_STORAGE_KEY, token);
  } catch (err) {
    logger.warn("could not save token to sessionStorage; it will last until reload", err);
  }
}

export function clearToken(): void {
  memoryToken = null;
  try {
    sessionStorage.removeItem(TOKEN_STORAGE_KEY);
  } catch (err) {
    logger.warn("could not clear token from sessionStorage", err);
  }
}

/** Move a `#token=` fragment into storage and remove it from the address bar and history. */
export function captureTokenFromUrl(): void {
  const token = readTokenFromFragment(window.location.hash);
  if (!token) return;
  setToken(token);
  history.replaceState(null, "", window.location.pathname + window.location.search);
}

/**
 * Add the bearer token, and a JSON content type for body-carrying requests
 * (the server rejects anything else). FormData bodies keep the multipart
 * type the browser generates.
 */
export function buildRequestInit(init: RequestInit, token: string | null): RequestInit {
  const headers = new Headers(init.headers);
  if (token) headers.set("Authorization", `Bearer ${token}`);
  const method = (init.method ?? "GET").toUpperCase();
  if (BODY_METHODS.has(method) && !(init.body instanceof FormData) && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }
  return { ...init, headers };
}

/** `fetch` for the Agent Town API: authenticates and reports a rejected token. */
export async function apiFetch(input: string, init: RequestInit = {}): Promise<Response> {
  const resp = await fetch(input, buildRequestInit(init, getToken()));
  if (resp.status === 401) {
    clearToken();
    window.dispatchEvent(new Event(UNAUTHORIZED_EVENT));
  }
  return resp;
}

/**
 * Append the token to a WebSocket URL. Browsers cannot set headers on
 * `new WebSocket()`, so the server accepts `?token=` on upgrades only.
 */
export function withTokenParam(url: string, token: string | null = getToken()): string {
  if (!token) return url;
  const separator = url.includes("?") ? "&" : "?";
  return `${url}${separator}${TOKEN_QUERY_PARAM}=${encodeURIComponent(token)}`;
}
