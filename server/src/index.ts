import { join } from "node:path";
import type { Heartbeat, RenameSessionRequest, WebSocketMessage } from "@agent-town/shared";
import { upsertMachine, getAllMachines, getMachine, renameSession } from "./store";

const PORT = Number(process.env.AGENT_TOWN_PORT || "4680");
const DASHBOARD_DIR = join(import.meta.dir, "../../dashboard/dist");

// Track connected dashboard WebSocket clients
const wsClients = new Set<{ ws: unknown; send: (data: string) => void }>();

// Track terminal proxy connections: browser ws -> agent ws
const terminalProxies = new Map<unknown, WebSocket>();

function broadcastToClients(message: WebSocketMessage): void {
  const data = JSON.stringify(message);
  for (const client of wsClients) {
    try {
      client.send(data);
    } catch {
      wsClients.delete(client);
    }
  }
}

const server = Bun.serve({
  port: PORT,
  hostname: "0.0.0.0",

  async fetch(req, server) {
    const url = new URL(req.url);

    // WebSocket upgrade for dashboard clients
    if (url.pathname === "/ws") {
      const upgraded = server.upgrade(req, { data: { type: "dashboard" } });
      if (!upgraded) {
        return new Response("WebSocket upgrade failed", { status: 400 });
      }
      return undefined;
    }

    // WebSocket upgrade for terminal proxy
    if (url.pathname === "/ws/terminal") {
      const machineId = url.searchParams.get("machineId");
      const sessionName = url.searchParams.get("session");
      const multiplexer = url.searchParams.get("multiplexer") || "zellij";
      const cols = url.searchParams.get("cols") || "120";
      const rows = url.searchParams.get("rows") || "40";

      if (!machineId || !sessionName) {
        return new Response("Missing machineId or session", { status: 400 });
      }

      const machine = getMachine(machineId);
      if (!machine || !machine.terminalPort) {
        return new Response("Machine not found or has no terminal server", { status: 404 });
      }

      const upgraded = server.upgrade(req, {
        data: {
          type: "terminal",
          machineId,
          sessionName,
          multiplexer,
          cols,
          rows,
          // For local dev, agent is on localhost. For remote, use machine hostname.
          agentHost: machine.agentAddress || machine.hostname,
          agentPort: machine.terminalPort,
        },
      });
      if (!upgraded) {
        return new Response("WebSocket upgrade failed", { status: 400 });
      }
      return undefined;
    }

    // API: receive heartbeat from agents
    if (url.pathname === "/api/heartbeat" && req.method === "POST") {
      try {
        const heartbeat: Heartbeat = await req.json();

        // Store the agent's address from the request for terminal proxying
        const agentAddress =
          req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
          new URL(req.url).hostname;
        upsertMachine(heartbeat);

        // Update the agent address after upsert
        const machine = getMachine(heartbeat.machineId);
        if (machine) {
          // For local connections, use localhost
          const isLocal = agentAddress === "127.0.0.1" || agentAddress === "::1" || agentAddress === "localhost";
          machine.agentAddress = isLocal ? "localhost" : agentAddress;
        }

        broadcastToClients({
          type: "machines_update",
          payload: getAllMachines(),
        });

        return Response.json({ ok: true });
      } catch {
        return Response.json(
          { error: "Invalid heartbeat payload" },
          { status: 400 }
        );
      }
    }

    // API: rename a session
    if (url.pathname === "/api/sessions/rename" && req.method === "POST") {
      try {
        const body: RenameSessionRequest = await req.json();
        const ok = renameSession(body.machineId, body.sessionId, body.name);
        if (!ok) {
          return Response.json({ error: "Session not found" }, { status: 404 });
        }
        broadcastToClients({
          type: "machines_update",
          payload: getAllMachines(),
        });
        return Response.json({ ok: true });
      } catch {
        return Response.json({ error: "Invalid payload" }, { status: 400 });
      }
    }

    // API: get all machines
    if (url.pathname === "/api/machines" && req.method === "GET") {
      return Response.json(getAllMachines());
    }

    // Serve dashboard static files
    const filePath = url.pathname === "/" ? "/index.html" : url.pathname;
    const file = Bun.file(join(DASHBOARD_DIR, filePath));
    if (await file.exists()) {
      return new Response(file);
    }

    // SPA fallback
    const indexFile = Bun.file(join(DASHBOARD_DIR, "index.html"));
    if (await indexFile.exists()) {
      return new Response(indexFile);
    }

    return new Response("Not found", { status: 404 });
  },

  websocket: {
    open(ws) {
      const data = ws.data as { type: string; [key: string]: unknown };

      if (data.type === "dashboard") {
        const client = {
          ws,
          send: (d: string) => ws.send(d),
        };
        wsClients.add(client);
        ws.send(
          JSON.stringify({
            type: "machines_update",
            payload: getAllMachines(),
          })
        );
        return;
      }

      if (data.type === "terminal") {
        const { agentHost, agentPort, sessionName, multiplexer, cols, rows } =
          data as {
            agentHost: string;
            agentPort: number;
            sessionName: string;
            multiplexer: string;
            cols: string;
            rows: string;
          };

        // Connect to the agent's terminal WebSocket
        const agentUrl =
          `ws://${agentHost}:${agentPort}/ws/terminal` +
          `?session=${encodeURIComponent(sessionName)}` +
          `&multiplexer=${multiplexer}` +
          `&cols=${cols}&rows=${rows}`;

        const agentWs = new WebSocket(agentUrl);

        agentWs.binaryType = "arraybuffer";

        agentWs.onopen = () => {
          // Proxy is established
        };

        agentWs.onmessage = (event) => {
          try {
            if (event.data instanceof ArrayBuffer) {
              ws.send(new Uint8Array(event.data));
            } else {
              ws.send(event.data);
            }
          } catch {
            agentWs.close();
          }
        };

        agentWs.onclose = () => {
          try {
            ws.close();
          } catch {
            // already closed
          }
          terminalProxies.delete(ws);
        };

        agentWs.onerror = () => {
          try {
            ws.send("\r\n\x1b[31mFailed to connect to agent terminal server\x1b[0m\r\n");
            ws.close();
          } catch {
            // already closed
          }
        };

        terminalProxies.set(ws, agentWs);
      }
    },

    message(ws, message) {
      // Forward terminal data from browser to agent
      const agentWs = terminalProxies.get(ws);
      if (agentWs && agentWs.readyState === WebSocket.OPEN) {
        if (typeof message === "string") {
          agentWs.send(message);
        } else {
          agentWs.send(message);
        }
      }
    },

    close(ws) {
      // Clean up dashboard clients
      for (const client of wsClients) {
        if (client.ws === ws) {
          wsClients.delete(client);
          break;
        }
      }

      // Clean up terminal proxies
      const agentWs = terminalProxies.get(ws);
      if (agentWs) {
        agentWs.close();
        terminalProxies.delete(ws);
      }
    },
  },
});

console.log(`Agent Town Server listening on http://0.0.0.0:${PORT}`);
console.log(`  Dashboard: http://localhost:${PORT}`);
console.log(`  API:       http://localhost:${PORT}/api/machines`);
console.log(`  WebSocket: ws://localhost:${PORT}/ws`);
