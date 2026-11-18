import { describe, expect, test } from "bun:test";

import { guardServerRequest, isProtectedPath } from "./server-guard";

const TOKEN = "server-token-0123456789abcdefghijk";
const OPTIONS = { token: TOKEN, allowedOrigins: ["http://localhost:5173"] };

function makeRequest(path: string, headers: Record<string, string> = {}, method = "GET"): Request {
  return new Request(`http://127.0.0.1:4680${path}`, { method, headers: { host: "127.0.0.1:4680", ...headers } });
}

describe("isProtectedPath", () => {
  test("protects the API and WebSocket routes", () => {
    for (const path of ["/api/machines", "/api/sessions/send", "/ws", "/ws/terminal"]) {
      expect(isProtectedPath(path)).toBe(true);
    }
  });

  test("leaves the dashboard's static files public so the login page can load", () => {
    for (const path of ["/", "/index.html", "/assets/index.js", "/wsx", "/apis"]) {
      expect(isProtectedPath(path)).toBe(false);
    }
  });
});

describe("guardServerRequest", () => {
  test("serves static files without a token", () => {
    expect(guardServerRequest(makeRequest("/"), OPTIONS)).toBeNull();
  });

  test("requires the token on API routes", () => {
    expect(guardServerRequest(makeRequest("/api/machines"), OPTIONS)?.status).toBe(401);
  });

  test("allows the dashboard's own origin", () => {
    const req = makeRequest("/api/machines", { authorization: `Bearer ${TOKEN}`, origin: "http://127.0.0.1:4680" });
    expect(guardServerRequest(req, OPTIONS)).toBeNull();
  });

  test("allows a configured extra origin such as the Vite dev server", () => {
    const req = makeRequest("/api/machines", { authorization: `Bearer ${TOKEN}`, origin: "http://localhost:5173" });
    expect(guardServerRequest(req, OPTIONS)).toBeNull();
  });

  test("accepts multipart only on the upload endpoint", () => {
    const headers = { authorization: `Bearer ${TOKEN}`, "content-type": "multipart/form-data; boundary=x" };
    expect(guardServerRequest(makeRequest("/api/sessions/upload?machineId=m", headers, "POST"), OPTIONS)).toBeNull();
    expect(guardServerRequest(makeRequest("/api/agents/launch", headers, "POST"), OPTIONS)?.status).toBe(415);
  });
});
