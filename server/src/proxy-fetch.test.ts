import { describe, expect, mock, test } from "bun:test";
import {
  broadcastToClients,
  PROXY_LAUNCH_TIMEOUT_MS,
  PROXY_TIMEOUT_MS,
  proxyFetch,
  WS_CONNECT_TIMEOUT_MS,
} from "./proxy-fetch";

describe("proxyFetch", () => {
  test("returns response data on successful fetch", async () => {
    const mockData = { sessions: ["s1", "s2"] };
    const mockResponse = new Response(JSON.stringify(mockData), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });

    const originalFetch = globalThis.fetch;
    globalThis.fetch = mock(() => Promise.resolve(mockResponse));

    try {
      const result = await proxyFetch("http://localhost:4681/api/sessions");
      expect(result.ok).toBe(true);
      expect(result.response).toBeInstanceOf(Response);
      expect(result.response?.status).toBe(200);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("returns timeout error when agent does not respond in time", async () => {
    const originalFetch = globalThis.fetch;
    // Simulate a fetch that never resolves until aborted
    globalThis.fetch = mock((_url: string, init?: RequestInit) => {
      return new Promise<Response>((_resolve, reject) => {
        if (init?.signal) {
          init.signal.addEventListener("abort", () => {
            reject(new DOMException("The operation timed out.", "TimeoutError"));
          });
        }
      });
    });

    try {
      const result = await proxyFetch("http://unreachable:4681/api/sessions", {}, 50);
      expect(result.ok).toBe(false);
      expect(result.status).toBe(504);
      expect(result.error).toBe("agent_timeout");
      expect(result.message).toContain("did not respond");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("returns network error on ECONNREFUSED", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mock(() => Promise.reject(new Error("fetch failed: ECONNREFUSED")));

    try {
      const result = await proxyFetch("http://dead-host:4681/api/sessions");
      expect(result.ok).toBe(false);
      expect(result.status).toBe(502);
      expect(result.error).toBe("agent_unreachable");
      expect(result.message).toContain("ECONNREFUSED");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("forwards request init options (method, headers, body)", async () => {
    const originalFetch = globalThis.fetch;
    let capturedUrl = "";
    let capturedInit: RequestInit | undefined;
    globalThis.fetch = mock((url: string, init?: RequestInit) => {
      capturedUrl = url;
      capturedInit = init;
      return Promise.resolve(new Response(JSON.stringify({ ok: true }), { status: 200 }));
    });

    try {
      const body = JSON.stringify({ session: "test" });
      await proxyFetch("http://localhost:4681/api/kill", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body,
      });

      expect(capturedUrl).toBe("http://localhost:4681/api/kill");
      expect(capturedInit?.method).toBe("POST");
      expect(capturedInit?.body).toBe(body);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("uses default timeout from PROXY_TIMEOUT_MS", () => {
    expect(PROXY_TIMEOUT_MS).toBe(10_000);
  });

  test("has a longer timeout for launch/resume operations", () => {
    expect(PROXY_LAUNCH_TIMEOUT_MS).toBe(30_000);
  });

  test("attaches AbortSignal.timeout to fetch calls", async () => {
    const originalFetch = globalThis.fetch;
    let capturedSignal: AbortSignal | undefined;
    globalThis.fetch = mock((_url: string, init?: RequestInit) => {
      capturedSignal = init?.signal ?? undefined;
      return Promise.resolve(new Response(JSON.stringify({ ok: true }), { status: 200 }));
    });

    try {
      await proxyFetch("http://localhost:4681/api/test");
      expect(capturedSignal).toBeDefined();
      expect(capturedSignal).toBeInstanceOf(AbortSignal);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("treats AbortError the same as TimeoutError (504 response)", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mock(() => Promise.reject(new DOMException("The operation was aborted.", "AbortError")));

    try {
      const result = await proxyFetch("http://localhost:4681/api/sessions");
      expect(result.ok).toBe(false);
      expect(result.status).toBe(504);
      expect(result.error).toBe("agent_timeout");
      expect(result.message).toContain("did not respond");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("returns ok: true for non-200 agent responses (caller checks response.ok)", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mock(() =>
      Promise.resolve(new Response(JSON.stringify({ error: "not found" }), { status: 404 })),
    );

    try {
      const result = await proxyFetch("http://localhost:4681/api/sessions");
      // proxyFetch itself succeeds — the response reached us
      expect(result.ok).toBe(true);
      expect(result.response).toBeInstanceOf(Response);
      expect(result.response?.status).toBe(404);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("handles non-Error throwable in catch path", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mock(() => Promise.reject("string error"));

    try {
      const result = await proxyFetch("http://localhost:4681/api/sessions");
      expect(result.ok).toBe(false);
      expect(result.status).toBe(502);
      expect(result.error).toBe("agent_unreachable");
      expect(result.message).toBe("string error");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("uses custom timeout when provided", async () => {
    const originalFetch = globalThis.fetch;
    let capturedSignal: AbortSignal | undefined;
    globalThis.fetch = mock((_url: string, init?: RequestInit) => {
      capturedSignal = init?.signal ?? undefined;
      return Promise.resolve(new Response("{}", { status: 200 }));
    });

    try {
      await proxyFetch("http://localhost:4681/api/launch", {}, 30_000);
      expect(capturedSignal).toBeDefined();
      expect(capturedSignal).toBeInstanceOf(AbortSignal);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("WS_CONNECT_TIMEOUT_MS is 10 seconds", () => {
    expect(WS_CONNECT_TIMEOUT_MS).toBe(10_000);
  });

  test("timeout message includes rounded timeout value in seconds", async () => {
    const originalFetch = globalThis.fetch;
    // Simulate a timeout with a DOMException but control the timeoutMs parameter
    // to verify the message formatting without waiting
    globalThis.fetch = mock(() => Promise.reject(new DOMException("The operation timed out.", "TimeoutError")));

    try {
      const result = await proxyFetch("http://unreachable:4681/api/sessions", {}, 30_000);
      expect(result.ok).toBe(false);
      expect(result.message).toBe("Agent did not respond within 30s");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe("broadcastToClients", () => {
  test("sends message to all connected clients", () => {
    const sent: string[] = [];
    const clients = new Set([
      { ws: {}, send: (data: string) => sent.push(data) },
      { ws: {}, send: (data: string) => sent.push(data) },
    ]);

    broadcastToClients(clients, { type: "machines_update", payload: [] });

    expect(sent).toHaveLength(2);
    const parsed = JSON.parse(sent[0]);
    expect(parsed.type).toBe("machines_update");
  });

  test("removes failed clients without crashing", () => {
    const clients = new Set([
      {
        ws: {},
        send: () => {
          throw new Error("connection lost");
        },
      },
      { ws: {}, send: (_data: string) => {} },
    ]);

    // Should not throw
    expect(() => broadcastToClients(clients, { type: "machines_update", payload: [] })).not.toThrow();

    // The failed client should have been removed
    expect(clients.size).toBe(1);
  });

  test("handles empty client set", () => {
    const clients = new Set<{ ws: unknown; send: (data: string) => void }>();
    expect(() => broadcastToClients(clients, { type: "machines_update", payload: [] })).not.toThrow();
  });

  test("does not crash when all clients fail", () => {
    const clients = new Set([
      {
        ws: {},
        send: () => {
          throw new Error("gone");
        },
      },
      {
        ws: {},
        send: () => {
          throw new Error("also gone");
        },
      },
    ]);

    expect(() => broadcastToClients(clients, { type: "machines_update", payload: [] })).not.toThrow();
    expect(clients.size).toBe(0);
  });

  test("iterates safely despite concurrent Set mutation", () => {
    // This tests that broadcastToClients copies the set before iterating
    // so that deleting during iteration doesn't cause issues
    const goodSent: string[] = [];
    const failClient = {
      ws: {},
      send: () => {
        throw new Error("fail");
      },
    };
    const goodClient = {
      ws: {},
      send: (data: string) => goodSent.push(data),
    };

    const clients = new Set([failClient, goodClient]);

    broadcastToClients(clients, { type: "machines_update", payload: [] });

    // Good client should still receive the message
    expect(goodSent).toHaveLength(1);
    // Failed client should be removed
    expect(clients.has(failClient)).toBe(false);
    expect(clients.has(goodClient)).toBe(true);
  });
});
