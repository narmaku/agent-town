import { join } from "node:path";
import type { Heartbeat, WebSocketMessage } from "@agent-town/shared";
import { upsertMachine, getAllMachines } from "./store";

const PORT = Number(process.env.AGENT_TOWN_PORT || "4680");
const DASHBOARD_DIR = join(import.meta.dir, "../../dashboard/dist");

// Track connected dashboard WebSocket clients
const wsClients = new Set<{ ws: unknown; send: (data: string) => void }>();

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
      const upgraded = server.upgrade(req);
      if (!upgraded) {
        return new Response("WebSocket upgrade failed", { status: 400 });
      }
      return undefined;
    }

    // API: receive heartbeat from agents
    if (url.pathname === "/api/heartbeat" && req.method === "POST") {
      try {
        const heartbeat: Heartbeat = await req.json();
        upsertMachine(heartbeat);

        // Broadcast update to all dashboard clients
        broadcastToClients({
          type: "machines_update",
          payload: getAllMachines(),
        });

        return Response.json({ ok: true });
      } catch (error) {
        return Response.json(
          { error: "Invalid heartbeat payload" },
          { status: 400 }
        );
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
      const client = {
        ws,
        send: (data: string) => ws.send(data),
      };
      wsClients.add(client);
      // Send current state immediately on connect
      ws.send(
        JSON.stringify({
          type: "machines_update",
          payload: getAllMachines(),
        })
      );
    },
    message(_ws, _message) {
      // Dashboard clients don't send messages (yet — future: terminal relay)
    },
    close(ws) {
      for (const client of wsClients) {
        if (client.ws === ws) {
          wsClients.delete(client);
          break;
        }
      }
    },
  },
});

console.log(`Agent Town Server listening on http://0.0.0.0:${PORT}`);
console.log(`  Dashboard: http://localhost:${PORT}`);
console.log(`  API:       http://localhost:${PORT}/api/machines`);
console.log(`  WebSocket: ws://localhost:${PORT}/ws`);
