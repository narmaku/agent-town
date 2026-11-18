import { describe, expect, test } from "bun:test";

import {
  authHeaders,
  extractToken,
  guardRequest,
  hasAllowedContentType,
  isOriginAllowed,
  parseOriginList,
  type RequestGuardOptions,
  tokensMatch,
} from "./request-guard";

const TOKEN = "secret-token-0123456789abcdefghijk";

function makeRequest(path: string, init: { method?: string; headers?: Record<string, string> } = {}): Request {
  return new Request(`http://127.0.0.1:4680${path}`, {
    method: init.method ?? "GET",
    headers: { host: "127.0.0.1:4680", ...init.headers },
  });
}

function makeOptions(overrides: Partial<RequestGuardOptions> = {}): RequestGuardOptions {
  return { token: TOKEN, allowedOrigins: [], allowSameOrigin: true, ...overrides };
}

const WS_HEADERS = { upgrade: "websocket", connection: "Upgrade" };

describe("tokensMatch", () => {
  test("accepts the exact token", () => {
    expect(tokensMatch(TOKEN, TOKEN)).toBe(true);
  });

  test("rejects a different token of the same length", () => {
    expect(tokensMatch(`${TOKEN.slice(0, -1)}X`, TOKEN)).toBe(false);
  });

  test("rejects tokens of a different length without throwing", () => {
    expect(tokensMatch("short", TOKEN)).toBe(false);
    expect(tokensMatch(`${TOKEN}extra`, TOKEN)).toBe(false);
  });

  test("never matches when no token is configured", () => {
    expect(tokensMatch("", "")).toBe(false);
  });
});

describe("extractToken", () => {
  test("reads a bearer Authorization header", () => {
    expect(extractToken(makeRequest("/api/x", { headers: authHeaders(TOKEN) }))).toBe(TOKEN);
  });

  test("ignores non-bearer Authorization schemes", () => {
    expect(extractToken(makeRequest("/api/x", { headers: { authorization: `Basic ${TOKEN}` } }))).toBeNull();
  });

  test("reads the query parameter on WebSocket upgrades", () => {
    expect(extractToken(makeRequest(`/ws?token=${TOKEN}`, { headers: WS_HEADERS }))).toBe(TOKEN);
  });

  test("ignores the query parameter on plain HTTP requests", () => {
    expect(extractToken(makeRequest(`/api/x?token=${TOKEN}`))).toBeNull();
  });
});

describe("isOriginAllowed", () => {
  test("allows requests without an Origin header (non-browser clients)", () => {
    expect(isOriginAllowed(makeRequest("/api/x"), makeOptions())).toBe(true);
  });

  test("allows the dashboard's own origin when same-origin is enabled", () => {
    const req = makeRequest("/api/x", { headers: { origin: "http://127.0.0.1:4680" } });
    expect(isOriginAllowed(req, makeOptions())).toBe(true);
  });

  test("rejects a foreign origin", () => {
    const req = makeRequest("/api/x", { headers: { origin: "https://evil.example" } });
    expect(isOriginAllowed(req, makeOptions())).toBe(false);
  });

  test("rejects a same-host origin on a different port", () => {
    const req = makeRequest("/api/x", { headers: { origin: "http://127.0.0.1:8080" } });
    expect(isOriginAllowed(req, makeOptions())).toBe(false);
  });

  test("rejects the literal null origin from sandboxed frames", () => {
    const req = makeRequest("/api/x", { headers: { origin: "null" } });
    expect(isOriginAllowed(req, makeOptions())).toBe(false);
  });

  test("rejects even same-origin requests when same-origin is disabled", () => {
    const req = makeRequest("/api/x", { headers: { origin: "http://127.0.0.1:4680" } });
    expect(isOriginAllowed(req, makeOptions({ allowSameOrigin: false }))).toBe(false);
  });

  test("allows origins on the configured allowlist", () => {
    const req = makeRequest("/api/x", { headers: { origin: "http://localhost:5173" } });
    expect(
      isOriginAllowed(req, makeOptions({ allowSameOrigin: false, allowedOrigins: ["http://localhost:5173"] })),
    ).toBe(true);
  });
});

describe("hasAllowedContentType", () => {
  test("does not constrain GET or DELETE requests", () => {
    expect(hasAllowedContentType(makeRequest("/api/x"))).toBe(true);
    expect(hasAllowedContentType(makeRequest("/api/x", { method: "DELETE" }))).toBe(true);
  });

  test("accepts JSON POSTs, with or without a charset", () => {
    const plain = makeRequest("/api/x", { method: "POST", headers: { "content-type": "application/json" } });
    const charset = makeRequest("/api/x", {
      method: "POST",
      headers: { "content-type": "Application/JSON; charset=utf-8" },
    });
    expect(hasAllowedContentType(plain)).toBe(true);
    expect(hasAllowedContentType(charset)).toBe(true);
  });

  test("rejects the content types a cross-site form can send without preflight", () => {
    for (const type of ["application/x-www-form-urlencoded", "multipart/form-data; boundary=x", "text/plain"]) {
      const req = makeRequest("/api/x", { method: "POST", headers: { "content-type": type } });
      expect(hasAllowedContentType(req)).toBe(false);
    }
  });

  test("rejects POSTs with no content type", () => {
    expect(hasAllowedContentType(makeRequest("/api/x", { method: "POST" }))).toBe(false);
  });

  test("requires multipart on upload paths and nowhere else", () => {
    const multipart = { "content-type": "multipart/form-data; boundary=x" };
    expect(
      hasAllowedContentType(makeRequest("/api/upload", { method: "POST", headers: multipart }), ["/api/upload"]),
    ).toBe(true);
    const json = { "content-type": "application/json" };
    expect(hasAllowedContentType(makeRequest("/api/upload", { method: "POST", headers: json }), ["/api/upload"])).toBe(
      false,
    );
  });
});

describe("guardRequest", () => {
  test("lets an authenticated same-origin JSON request through", () => {
    const req = makeRequest("/api/x", {
      method: "POST",
      headers: { ...authHeaders(TOKEN), origin: "http://127.0.0.1:4680", "content-type": "application/json" },
    });
    expect(guardRequest(req, makeOptions())).toBeNull();
  });

  test("returns 403 for a foreign origin before checking the token", () => {
    const req = makeRequest("/api/x", { headers: { ...authHeaders(TOKEN), origin: "https://evil.example" } });
    expect(guardRequest(req, makeOptions())?.status).toBe(403);
  });

  test("returns 401 when the token is missing", () => {
    expect(guardRequest(makeRequest("/api/x"), makeOptions())?.status).toBe(401);
  });

  test("returns 415 for an authenticated form post", () => {
    const req = makeRequest("/api/x", {
      method: "POST",
      headers: { ...authHeaders(TOKEN), "content-type": "application/x-www-form-urlencoded" },
    });
    expect(guardRequest(req, makeOptions())?.status).toBe(415);
  });

  test("accepts a WebSocket upgrade carrying the token in the query", () => {
    const req = makeRequest(`/ws?token=${TOKEN}`, { headers: { ...WS_HEADERS, origin: "http://127.0.0.1:4680" } });
    expect(guardRequest(req, makeOptions())).toBeNull();
  });

  test("rejects a cross-site WebSocket upgrade even with a valid token", () => {
    const req = makeRequest(`/ws?token=${TOKEN}`, { headers: { ...WS_HEADERS, origin: "https://evil.example" } });
    expect(guardRequest(req, makeOptions())?.status).toBe(403);
  });
});

describe("parseOriginList", () => {
  test("returns an empty list when unset", () => {
    expect(parseOriginList(undefined)).toEqual([]);
    expect(parseOriginList("")).toEqual([]);
  });

  test("normalizes entries to bare origins", () => {
    expect(parseOriginList(" http://localhost:5173/ , https://town.example/path")).toEqual([
      "http://localhost:5173",
      "https://town.example",
    ]);
  });

  test("drops entries that are not URLs", () => {
    expect(parseOriginList("not a url,http://ok.example")).toEqual(["http://ok.example"]);
  });
});
