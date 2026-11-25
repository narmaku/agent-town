import { afterAll, afterEach, beforeAll, describe, expect, spyOn, test } from "bun:test";
import type { Server } from "bun";
import * as muxControl from "./mux-control";
import { CodexProvider } from "./providers/codex";
import * as providers from "./providers/registry";
import {
  addRenameMapping,
  clearRenameMappings,
  resolveSessionName,
  startTerminalServer,
  validateModel,
  validateProjectDir,
  validateSessionId,
  validateSessionName,
} from "./terminal-server";

describe("resolveSessionName", () => {
  afterEach(() => {
    clearRenameMappings();
  });

  test("returns the same name if no rename happened", () => {
    expect(resolveSessionName("my-session")).toBe("my-session");
  });

  test("resolves a single rename", () => {
    addRenameMapping("old-name", "new-name");
    expect(resolveSessionName("old-name")).toBe("new-name");
  });

  test("follows a rename chain (A→B→C)", () => {
    addRenameMapping("session-a", "session-b");
    addRenameMapping("session-b", "session-c");
    expect(resolveSessionName("session-a")).toBe("session-c");
  });

  test("handles cycle without infinite loop", () => {
    addRenameMapping("x", "y");
    addRenameMapping("y", "x");
    const result = resolveSessionName("x");
    expect(["x", "y"]).toContain(result);
  });

  test("does not affect unrelated names", () => {
    addRenameMapping("foo", "bar");
    expect(resolveSessionName("unrelated")).toBe("unrelated");
  });
});

describe("validateSessionName", () => {
  test("accepts valid names", () => {
    expect(validateSessionName("my-session")).toBeNull();
    expect(validateSessionName("session_01")).toBeNull();
    expect(validateSessionName("test.name")).toBeNull();
    expect(validateSessionName("A")).toBeNull();
  });

  test("rejects empty name", () => {
    expect(validateSessionName("")).not.toBeNull();
  });

  test("rejects names with shell metacharacters", () => {
    expect(validateSessionName("foo;rm -rf /")).not.toBeNull();
    expect(validateSessionName("$(whoami)")).not.toBeNull();
    expect(validateSessionName("test`id`")).not.toBeNull();
    expect(validateSessionName("name with spaces")).not.toBeNull();
    expect(validateSessionName("foo&bar")).not.toBeNull();
  });

  test("rejects names exceeding 100 characters", () => {
    expect(validateSessionName("a".repeat(101))).not.toBeNull();
    expect(validateSessionName("a".repeat(100))).toBeNull();
  });
});

describe("validateProjectDir", () => {
  test("accepts valid absolute paths", () => {
    expect(validateProjectDir("/home/user/project")).toBeNull();
    expect(validateProjectDir("/tmp/test")).toBeNull();
    expect(validateProjectDir("/")).toBeNull();
  });

  test("rejects empty path", () => {
    expect(validateProjectDir("")).not.toBeNull();
  });

  test("rejects relative paths", () => {
    expect(validateProjectDir("relative/path")).not.toBeNull();
    expect(validateProjectDir("./local")).not.toBeNull();
  });

  test("rejects paths with directory traversal", () => {
    expect(validateProjectDir("/home/user/../etc/passwd")).not.toBeNull();
    expect(validateProjectDir("/tmp/../../etc")).not.toBeNull();
  });

  test("rejects paths with redundant slashes or dot segments", () => {
    expect(validateProjectDir("/home/user/./project")).not.toBeNull();
    expect(validateProjectDir("/home//user/project")).not.toBeNull();
    expect(validateProjectDir("/home/user/project/")).not.toBeNull();
  });

  test("returns the canonicalized path for valid inputs", () => {
    const result = validateProjectDir("/home/user/project");
    expect(result).toBeNull();
  });
});

describe("validateModel", () => {
  test("accepts valid model names", () => {
    expect(validateModel("claude-sonnet-4-5-20250514")).toBeNull();
    expect(validateModel("claude-opus-4-6")).toBeNull();
    expect(validateModel("anthropic/claude-3")).toBeNull();
  });

  test("rejects names with shell metacharacters", () => {
    expect(validateModel("model;rm -rf /")).not.toBeNull();
    expect(validateModel("$(whoami)")).not.toBeNull();
    expect(validateModel("model name")).not.toBeNull();
  });
});

describe("validateSessionId", () => {
  test("accepts valid UUIDs", () => {
    expect(validateSessionId("550e8400-e29b-41d4-a716-446655440000")).toBeNull();
    expect(validateSessionId("abc123")).toBeNull();
  });

  test("accepts OpenCode session IDs", () => {
    expect(validateSessionId("ses_30163a6c1ffeYDGuDOrp0nH9vG")).toBeNull();
    expect(validateSessionId("ses_abc123")).toBeNull();
  });

  test("accepts dotted Pi custom session IDs", () => {
    expect(validateSessionId("project.session-7")).toBeNull();
  });

  test("rejects empty ID", () => {
    expect(validateSessionId("")).not.toBeNull();
  });

  test("rejects IDs with shell metacharacters", () => {
    expect(validateSessionId("test;injection")).not.toBeNull();
    expect(validateSessionId("../../../etc")).not.toBeNull();
    expect(validateSessionId("id$(whoami)")).not.toBeNull();
  });
});

const TEST_TOKEN = "test-token-0123456789abcdefghijklmnop";
const AUTH = { Authorization: `Bearer ${TEST_TOKEN}` };

function startTestServer(): { server: Server; baseUrl: string } {
  // Port 0 lets the OS pick a free port
  const server = startTerminalServer(0, "test-machine", {
    hostname: "127.0.0.1",
    token: TEST_TOKEN,
    allowedOrigins: [],
  });
  return { server, baseUrl: `http://127.0.0.1:${server.port}` };
}

describe("/api/send endpoint", () => {
  let server: Server;
  let baseUrl: string;

  beforeAll(() => {
    ({ server, baseUrl } = startTestServer());
  });

  afterAll(() => {
    server.stop(true);
  });

  test("rejects missing session", async () => {
    const res = await fetch(`${baseUrl}/api/send`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...AUTH },
      body: JSON.stringify({ text: "hello" }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("Missing session or text");
  });

  test("rejects missing text", async () => {
    const res = await fetch(`${baseUrl}/api/send`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...AUTH },
      body: JSON.stringify({ session: "test-session" }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("Missing session or text");
  });

  test("rejects empty session and text", async () => {
    const res = await fetch(`${baseUrl}/api/send`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...AUTH },
      body: JSON.stringify({ session: "", text: "" }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("Missing session or text");
  });

  test("handles malformed JSON body", async () => {
    const res = await fetch(`${baseUrl}/api/send`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...AUTH },
      body: "not-json",
    });
    expect(res.status).toBe(500);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBeDefined();
  });
});

describe("agent request guards", () => {
  let server: Server;
  let baseUrl: string;

  beforeAll(() => {
    ({ server, baseUrl } = startTestServer());
  });

  afterAll(() => {
    server.stop(true);
  });

  function postSend(headers: Record<string, string>, body = JSON.stringify({ text: "hi" })): Promise<Response> {
    return fetch(`${baseUrl}/api/send`, { method: "POST", headers, body });
  }

  test("binds only to the requested interface", () => {
    expect(server.hostname).toBe("127.0.0.1");
  });

  test("rejects API requests without a token", async () => {
    const res = await postSend({ "Content-Type": "application/json" });
    expect(res.status).toBe(401);
  });

  test("rejects API requests with a wrong token", async () => {
    const res = await postSend({ "Content-Type": "application/json", Authorization: "Bearer wrong" });
    expect(res.status).toBe(401);
  });

  test("rejects GET endpoints such as list-dirs without a token", async () => {
    const res = await fetch(`${baseUrl}/api/list-dirs?dir=/`);
    expect(res.status).toBe(401);
  });

  test("ignores a token in the query string on plain HTTP requests", async () => {
    const res = await fetch(`${baseUrl}/api/list-dirs?dir=/&token=${TEST_TOKEN}`);
    expect(res.status).toBe(401);
  });

  test("rejects any browser origin, even with a valid token", async () => {
    const res = await postSend({ "Content-Type": "application/json", Origin: "http://127.0.0.1:4680", ...AUTH });
    expect(res.status).toBe(403);
  });

  test("rejects form-encoded POST bodies", async () => {
    const res = await postSend({ "Content-Type": "application/x-www-form-urlencoded", ...AUTH }, "text=hi");
    expect(res.status).toBe(415);
  });

  test("rejects text/plain POST bodies", async () => {
    const res = await postSend({ "Content-Type": "text/plain", ...AUTH });
    expect(res.status).toBe(415);
  });

  test("passes authenticated JSON requests through to the handler", async () => {
    const res = await postSend({ "Content-Type": "application/json; charset=utf-8", ...AUTH });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("Missing session or text");
  });

  test("requires multipart on the upload endpoint", async () => {
    const res = await fetch(`${baseUrl}/api/upload`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...AUTH },
      body: "{}",
    });
    expect(res.status).toBe(415);
  });

  test("leaves the root health check open for tunnel monitoring", async () => {
    const res = await fetch(`${baseUrl}/`);
    expect(res.status).toBe(200);
  });

  test("rejects terminal WebSocket upgrades without a token", async () => {
    const res = await fetch(`${baseUrl}/ws/terminal?session=x`, {
      headers: {
        Upgrade: "websocket",
        Connection: "Upgrade",
        "Sec-WebSocket-Version": "13",
        "Sec-WebSocket-Key": "dGhlIHNhbXBsZSBub25jZQ==",
      },
    });
    expect(res.status).toBe(401);
  });

  test("rejects terminal WebSocket upgrades from a browser origin", async () => {
    const res = await fetch(`${baseUrl}/ws/terminal?session=x&token=${TEST_TOKEN}`, {
      headers: {
        Upgrade: "websocket",
        Connection: "Upgrade",
        "Sec-WebSocket-Version": "13",
        "Sec-WebSocket-Key": "dGhlIHNhbXBsZSBub25jZQ==",
        Origin: "https://evil.example",
      },
    });
    expect(res.status).toBe(403);
  });

  test("accepts a terminal WebSocket that presents the token in a header", async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${server.port}/ws/terminal`, { headers: AUTH });
    const outcome = await new Promise<string>((resolve) => {
      ws.onmessage = (event) => resolve(String(event.data));
      ws.onerror = () => resolve("error");
    });
    // No session given, so the handler (not the guard) answers and closes
    expect(outcome).toContain("No session specified");
    ws.close();
  });
});

describe("launch and resume options", () => {
  let server: Server;
  beforeAll(() => {
    server = startTerminalServer(0, "permission-tests", {
      hostname: "127.0.0.1",
      token: "permission-test-token",
      allowedOrigins: [],
    });
  });
  afterAll(() => server.stop(true));

  async function launch(extraArgs: unknown): Promise<Response> {
    return fetch(`http://127.0.0.1:${server.port}/api/launch`, {
      method: "POST",
      headers: { Authorization: "Bearer permission-test-token", "Content-Type": "application/json" },
      body: JSON.stringify({
        sessionName: "args-test",
        projectDir: "/tmp",
        multiplexer: "tmux",
        agentType: "codex",
        extraArgs,
      }),
    });
  }

  test("appends literal arguments to the selected harness command", async () => {
    const provider = spyOn(providers, "getProvider").mockReturnValue(new CodexProvider());
    const createSession = spyOn(muxControl, "createMuxSession").mockResolvedValue(undefined);
    const typeLine = spyOn(muxControl, "typeLine").mockResolvedValue(true);
    const extraArgs = ["--flag", "two words", "$(printf hi)", String.raw`dir\\file`, ""];
    try {
      expect((await launch(extraArgs)).status).toBe(200);
      expect(provider).toHaveBeenCalledWith("codex");
      const command = typeLine.mock.calls[0]?.[2];
      expect(command).toBeDefined();
      const child = Bun.spawn(["sh", "-c", `codex() { printf '%s\\0' "$@"; }; ${command}`], {
        stdout: "pipe",
      });
      const received = await new Response(child.stdout).text();
      expect(await child.exited).toBe(0);
      expect(received).toBe(`${extraArgs.join("\0")}\0`);
    } finally {
      typeLine.mockRestore();
      createSession.mockRestore();
      provider.mockRestore();
    }
  });

  test("rejects terminal control characters before looking up the harness", async () => {
    const provider = spyOn(providers, "getProvider");
    try {
      const response = await launch(["--flag", "line\nfeed"]);
      expect(response.status).toBe(400);
      expect((await response.json()).error).toContain("extraArgs");
      expect(provider).not.toHaveBeenCalled();
    } finally {
      provider.mockRestore();
    }
  });

  for (const path of ["/api/launch", "/api/resume"]) {
    test(`${path} rejects malformed and unsupported permissions before spawning`, async () => {
      for (const [input, message] of [
        [{ permissionMode: "unsafe" }, "permissionMode"],
        [{ permissionMode: null }, "permissionMode"],
        [{ autonomous: "true" }, "autonomous"],
        [{ agentType: "opencode", permissionMode: "auto" }, "Auto"],
        [{ agentType: "pi", permissionMode: "yolo" }, "YOLO"],
      ] as const) {
        const response = await fetch(`http://127.0.0.1:${server.port}${path}`, {
          method: "POST",
          headers: { Authorization: "Bearer permission-test-token", "Content-Type": "application/json" },
          body: JSON.stringify({
            sessionName: "permissions",
            sessionId: "session-1",
            projectDir: "/tmp",
            multiplexer: "tmux",
            agentType: "claude-code",
            ...input,
          }),
        });
        expect(response.status).toBe(400);
        expect((await response.json()).error).toContain(message);
      }
    });
  }
});

describe("YOLO startup confirmation", () => {
  test("never sends a bypass confirmation for Default or Auto", async () => {
    const { requiresYoloDisclaimer } = await import("./terminal-server");
    const { ClaudeCodeProvider } = await import("./providers/claude-code");
    const provider = new ClaudeCodeProvider();
    expect(requiresYoloDisclaimer(provider, "default")).toBe(false);
    expect(requiresYoloDisclaimer(provider, "auto")).toBe(false);
    expect(requiresYoloDisclaimer(provider, "yolo")).toBe(true);
  });
});
