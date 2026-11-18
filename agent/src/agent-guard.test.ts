import { describe, expect, test } from "bun:test";

import { guardAgentRequest, isAgentProtectedPath, resolveAgentBindHost } from "./agent-guard";

describe("resolveAgentBindHost", () => {
  test("binds to loopback when the server is on this machine", () => {
    expect(resolveAgentBindHost("http://127.0.0.1:4680", undefined)).toBe("127.0.0.1");
    expect(resolveAgentBindHost("http://localhost:4680", undefined)).toBe("127.0.0.1");
    expect(resolveAgentBindHost("http://[::1]:4680", undefined)).toBe("127.0.0.1");
  });

  test("binds to all interfaces when the server must dial in over the LAN", () => {
    expect(resolveAgentBindHost("http://192.168.1.20:4680", undefined)).toBe("0.0.0.0");
  });

  test("an explicit AGENT_TOWN_TERMINAL_HOST always wins", () => {
    expect(resolveAgentBindHost("http://192.168.1.20:4680", "10.8.0.2")).toBe("10.8.0.2");
    expect(resolveAgentBindHost("http://127.0.0.1:4680", "0.0.0.0")).toBe("0.0.0.0");
  });
});

describe("guardAgentRequest", () => {
  const opts = { token: "agent-guard-token-0123456789abcdef", allowedOrigins: [] };

  test("protects API and terminal routes but not the health check", () => {
    expect(isAgentProtectedPath("/api/launch")).toBe(true);
    expect(isAgentProtectedPath("/ws/terminal")).toBe(true);
    expect(isAgentProtectedPath("/")).toBe(false);
  });

  test("rejects the server's own dashboard origin, since browsers never call the agent", () => {
    const req = new Request("http://127.0.0.1:4681/api/send", {
      method: "POST",
      headers: {
        host: "127.0.0.1:4681",
        origin: "http://127.0.0.1:4681",
        authorization: `Bearer ${opts.token}`,
        "content-type": "application/json",
      },
    });
    expect(guardAgentRequest(req, opts)?.status).toBe(403);
  });
});
