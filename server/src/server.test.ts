import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Heartbeat } from "@agent-town/shared";
import type { Server } from "bun";

import { startServer } from "./index";

const TOKEN = "integration-token-0123456789abcdef";
const AUTH = { Authorization: `Bearer ${TOKEN}` };
const MACHINE_ID = "guard-integration-machine";
const UPGRADE_HEADERS = {
  Upgrade: "websocket",
  Connection: "Upgrade",
  "Sec-WebSocket-Version": "13",
  "Sec-WebSocket-Key": "dGhlIHNhbXBsZSBub25jZQ==",
};

interface StubAgent {
  server: Server;
  seenAuth: (string | null)[];
}

/** A stand-in agent that, like the real one, only answers requests carrying the token. */
function startStubAgent(): StubAgent {
  const seenAuth: (string | null)[] = [];
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch(req, srv) {
      const auth = req.headers.get("authorization");
      seenAuth.push(auth);
      if (auth !== `Bearer ${TOKEN}`) return Response.json({ error: "Unauthorized" }, { status: 401 });
      if (new URL(req.url).pathname === "/ws/terminal") {
        return srv.upgrade(req, { data: undefined }) ? undefined : new Response("upgrade failed", { status: 400 });
      }
      return Response.json({ dirs: ["a", "b"] });
    },
    websocket: {
      message(ws, message) {
        ws.send(`echo:${message}`);
      },
    },
  });
  return { server, seenAuth };
}

function makeHeartbeat(terminalPort: number): Heartbeat {
  return {
    machineId: MACHINE_ID,
    hostname: "guard-integration-host",
    platform: "linux",
    sessions: [],
    multiplexers: [],
    multiplexerSessions: [],
    availableAgents: [],
    terminalPort,
    timestamp: new Date().toISOString(),
  };
}

describe("server request guards (integration)", () => {
  let server: Server;
  let agent: StubAgent;
  let baseUrl: string;
  let wsBase: string;
  let ownOrigin: string;

  beforeAll(async () => {
    server = startServer({ port: 0, hostname: "127.0.0.1", token: TOKEN, allowedOrigins: [] });
    baseUrl = `http://127.0.0.1:${server.port}`;
    wsBase = `ws://127.0.0.1:${server.port}`;
    ownOrigin = baseUrl;
    agent = startStubAgent();
    const res = await fetch(`${baseUrl}/api/heartbeat`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...AUTH },
      body: JSON.stringify(makeHeartbeat(agent.server.port)),
    });
    expect(res.status).toBe(200);
  });

  afterAll(() => {
    server.stop(true);
    agent.server.stop(true);
  });

  test("binds only to the requested interface", () => {
    expect(server.hostname).toBe("127.0.0.1");
  });

  test("serves the dashboard shell without a token", async () => {
    const res = await fetch(`${baseUrl}/`);
    expect(res.status).not.toBe(401);
  });

  test("rejects API reads without the token", async () => {
    const res = await fetch(`${baseUrl}/api/machines`);
    expect(res.status).toBe(401);
  });

  test("rejects heartbeats without the token", async () => {
    const res = await fetch(`${baseUrl}/api/heartbeat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(makeHeartbeat(1)),
    });
    expect(res.status).toBe(401);
  });

  test("rejects a cross-site form post to launch an agent", async () => {
    const res = await fetch(`${baseUrl}/api/agents/launch`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Origin: "https://evil.example" },
      body: "machineId=x&autonomous=true",
    });
    expect(res.status).toBe(403);
  });

  test("rejects non-JSON bodies even with the token", async () => {
    const res = await fetch(`${baseUrl}/api/sessions/send`, {
      method: "POST",
      headers: { "Content-Type": "text/plain", ...AUTH },
      body: "{}",
    });
    expect(res.status).toBe(415);
  });

  test("serves an authenticated same-origin dashboard request", async () => {
    const res = await fetch(`${baseUrl}/api/machines`, { headers: { ...AUTH, Origin: ownOrigin } });
    expect(res.status).toBe(200);
    const machines = (await res.json()) as { machineId: string }[];
    expect(machines.some((m) => m.machineId === MACHINE_ID)).toBe(true);
  });

  test("forwards the token when proxying to the agent", async () => {
    agent.seenAuth.length = 0;
    const res = await fetch(`${baseUrl}/api/list-dirs?machineId=${MACHINE_ID}&dir=/tmp`, { headers: AUTH });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ dirs: ["a", "b"] });
    expect(agent.seenAuth).toEqual([`Bearer ${TOKEN}`]);
  });

  test("rejects a dashboard WebSocket without the token", async () => {
    const res = await fetch(`${baseUrl}/ws`, { headers: { ...UPGRADE_HEADERS, Origin: ownOrigin } });
    expect(res.status).toBe(401);
  });

  test("rejects a cross-site WebSocket even with a leaked token", async () => {
    const res = await fetch(`${baseUrl}/ws?token=${TOKEN}`, {
      headers: { ...UPGRADE_HEADERS, Origin: "https://evil.example" },
    });
    expect(res.status).toBe(403);
  });

  test("streams machine updates to an authenticated dashboard WebSocket", async () => {
    const ws = new WebSocket(`${wsBase}/ws?token=${TOKEN}`, { headers: { Origin: ownOrigin } });
    const first = await new Promise<string>((resolve, reject) => {
      ws.onmessage = (event) => resolve(String(event.data));
      ws.onerror = () => reject(new Error("dashboard WebSocket failed"));
    });
    ws.close();
    expect(JSON.parse(first).type).toBe("machines_update");
  });

  test("relays an authenticated terminal WebSocket to the agent with the token", async () => {
    agent.seenAuth.length = 0;
    const params = new URLSearchParams({ machineId: MACHINE_ID, session: "s1", token: TOKEN });
    const ws = new WebSocket(`${wsBase}/ws/terminal?${params}`, { headers: { Origin: ownOrigin } });
    const reply = await new Promise<string>((resolve, reject) => {
      ws.onopen = () => {
        // Give the server a moment to finish its own connection to the agent
        setTimeout(() => ws.send("ping"), 200);
      };
      ws.onmessage = (event) => resolve(String(event.data));
      ws.onerror = () => reject(new Error("terminal WebSocket failed"));
    });
    ws.close();
    expect(reply).toBe("echo:ping");
    expect(agent.seenAuth).toEqual([`Bearer ${TOKEN}`]);
  });
});
