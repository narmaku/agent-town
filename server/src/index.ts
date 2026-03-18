import { join } from "node:path";
import {
  type CreateNodeRequest,
  createLogger,
  type Heartbeat,
  type LaunchAgentRequest,
  type RenameSessionRequest,
  type ResumeAgentRequest,
  type Settings,
  type UpdateNodeRequest,
  type WebSocketMessage,
} from "@agent-town/shared";
import { connectAutoNodes, connectNode, disconnectNode, resolveAgentEndpoint, testNodeConnection } from "./ssh-manager";
import {
  addPendingSession,
  createNode,
  deleteNode,
  getAllMachines,
  getAllNodes,
  getMachine,
  getNode,
  getSavedSessionName,
  getSessionMultiplexerInfo,
  getSessionSlug,
  getSettings,
  renameSession,
  updateMultiplexerSessionName,
  updateNode,
  updateSettings,
  upsertMachine,
} from "./store";

const log = createLogger("server");

const PORT = Number(process.env.AGENT_TOWN_PORT || "4680");
const DASHBOARD_DIR = join(import.meta.dir, "../../dashboard/dist");

// Track connected dashboard WebSocket clients
const wsClients = new Set<{ ws: unknown; send: (data: string) => void }>();

// Track terminal proxy connections: browser ws -> agent ws
const terminalProxies = new Map<unknown, WebSocket>();

/**
 * Get the correct host:port to reach a machine's agent.
 * For remote nodes connected via SSH tunnel, uses the tunnel's local forwarded port.
 * For local machines, uses the agent's own address and port.
 */
function getAgentUrl(
  machine: { hostname: string; agentAddress?: string; terminalPort?: number },
  path: string,
): string {
  const tunnel = resolveAgentEndpoint(machine.hostname);
  if (tunnel) {
    const url = `http://${tunnel.host}:${tunnel.port}${path}`;
    log.info(`route: ${machine.hostname} → tunnel ${url}`);
    return url;
  }
  const host = machine.agentAddress || machine.hostname;
  const url = `http://${host}:${machine.terminalPort}${path}`;
  log.info(`route: ${machine.hostname} → direct ${url}`);
  return url;
}

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

const _server = Bun.serve({
  port: PORT,
  hostname: "0.0.0.0",

  async fetch(req, server) {
    const url = new URL(req.url);

    // Log API requests at debug level
    if (url.pathname.startsWith("/api/")) {
      log.debug(`${req.method} ${url.pathname}`);
    }

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
      const session = url.searchParams.get("session");
      const multiplexer = url.searchParams.get("multiplexer") || "zellij";
      const cols = url.searchParams.get("cols") || "120";
      const rows = url.searchParams.get("rows") || "40";

      if (!machineId || !session) {
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
          session,
          multiplexer,
          cols,
          rows,
          agentHost: resolveAgentEndpoint(machine.hostname)?.host || machine.agentAddress || machine.hostname,
          agentPort: resolveAgentEndpoint(machine.hostname)?.port || machine.terminalPort,
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
        const agentAddress = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || new URL(req.url).hostname;
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
      } catch (err) {
        log.warn(`heartbeat: invalid payload: ${err instanceof Error ? err.message : String(err)}`);
        return Response.json({ error: "Invalid heartbeat payload" }, { status: 400 });
      }
    }

    // API: get paginated session messages (proxy to agent)
    if (url.pathname === "/api/session-messages" && req.method === "GET") {
      const machineId = url.searchParams.get("machineId");
      const sessionId = url.searchParams.get("sessionId");
      const agentType = url.searchParams.get("agentType") || "claude-code";
      const offset = url.searchParams.get("offset") || "0";
      const limit = url.searchParams.get("limit") || "10";

      if (!machineId || !sessionId) {
        return Response.json({ error: "Missing machineId or sessionId" }, { status: 400 });
      }

      const machine = getMachine(machineId);
      if (!machine || !machine.terminalPort) {
        return Response.json({ error: "Machine not found" }, { status: 404 });
      }

      const agentUrl =
        getAgentUrl(machine, "/api/session-messages") +
        `?sessionId=${encodeURIComponent(sessionId)}&agentType=${agentType}&offset=${offset}&limit=${limit}`;

      try {
        const agentResp = await fetch(agentUrl);
        const data = await agentResp.json();
        return Response.json(data, { status: agentResp.status });
      } catch (err) {
        log.error(`session-messages: failed to fetch from agent: ${err instanceof Error ? err.message : String(err)}`);
        return Response.json({ error: "Failed to fetch messages from agent" }, { status: 502 });
      }
    }

    // API: rename a session (also renames multiplexer session if active)
    if (url.pathname === "/api/sessions/rename" && req.method === "POST") {
      try {
        const body: RenameSessionRequest = await req.json();

        // Get multiplexer info before rename to sync the terminal session name
        const muxInfo = getSessionMultiplexerInfo(body.machineId, body.sessionId);

        const ok = renameSession(body.machineId, body.sessionId, body.name);
        if (!ok) {
          return Response.json({ error: "Session not found" }, { status: 404 });
        }

        // Rename the multiplexer session too
        if (muxInfo?.multiplexer && muxInfo?.multiplexerSession && body.name.trim()) {
          const newMuxName = body.name.trim();
          const currentMuxName = muxInfo.multiplexerSession;
          log.info(`rename: mux "${currentMuxName}" → "${newMuxName}" (${muxInfo.multiplexer})`);

          if (currentMuxName !== newMuxName) {
            const machine = getMachine(body.machineId);
            if (machine?.terminalPort) {
              const agentUrl = getAgentUrl(machine, "/api/rename-session");
              try {
                const agentResp = await fetch(agentUrl, {
                  method: "POST",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({
                    multiplexer: muxInfo.multiplexer,
                    currentName: currentMuxName,
                    newName: newMuxName,
                  }),
                });
                if (!agentResp.ok) {
                  const errText = await agentResp.text();
                  log.error(`rename: agent rename failed: ${errText}`);
                } else {
                  log.info("rename: agent rename succeeded");
                }
              } catch (err) {
                log.error(`rename: agent rename error: ${err instanceof Error ? err.message : String(err)}`);
              }
            } else {
              log.debug("rename: no terminalPort, skipping mux rename");
            }
          } else {
            log.debug("rename: mux name already matches, skipping");
          }
          // Update stored multiplexerSession immediately so subsequent
          // renames (before the next heartbeat) use the correct current name
          updateMultiplexerSessionName(body.machineId, body.sessionId, newMuxName);
        } else {
          log.debug(`rename: UI-only (no active mux session)`);
        }

        broadcastToClients({
          type: "machines_update",
          payload: getAllMachines(),
        });
        return Response.json({ ok: true });
      } catch (err) {
        log.warn(`rename: invalid payload: ${err instanceof Error ? err.message : String(err)}`);
        return Response.json({ error: "Invalid payload" }, { status: 400 });
      }
    }

    // API: kill/close a multiplexer session
    if (url.pathname === "/api/sessions/kill" && req.method === "POST") {
      try {
        const body = (await req.json()) as {
          machineId: string;
          multiplexer: string;
          session: string;
        };

        const machine = getMachine(body.machineId);
        if (!machine || !machine.terminalPort) {
          return Response.json({ error: "Machine not found" }, { status: 404 });
        }

        const agentUrl = getAgentUrl(machine, "/api/kill");

        const agentResp = await fetch(agentUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            multiplexer: body.multiplexer,
            session: body.session,
          }),
        });

        if (!agentResp.ok) {
          return Response.json({ error: "Agent kill failed" }, { status: 502 });
        }
        return Response.json({ ok: true });
      } catch (err) {
        log.error(`kill: failed: ${err instanceof Error ? err.message : String(err)}`);
        return Response.json({ error: "Failed to kill session" }, { status: 500 });
      }
    }

    // API: fully delete a session — kill mux, delete mux, delete JSONL, clean state
    if (url.pathname === "/api/sessions/delete" && req.method === "POST") {
      try {
        const body = (await req.json()) as {
          machineId: string;
          sessionId: string;
          multiplexer?: string;
          multiplexerSession?: string;
        };

        const machine = getMachine(body.machineId);
        if (!machine || !machine.terminalPort) {
          return Response.json({ error: "Machine not found" }, { status: 404 });
        }

        // Step 1+2: Kill and delete the mux session (if one is associated)
        const muxSession =
          body.multiplexerSession || getSessionMultiplexerInfo(body.machineId, body.sessionId)?.multiplexerSession;
        const muxType = body.multiplexer || getSessionMultiplexerInfo(body.machineId, body.sessionId)?.multiplexer;
        if (muxSession && muxType) {
          log.info(`delete: killing mux session=${muxSession} type=${muxType}`);
          try {
            const killUrl = getAgentUrl(machine, "/api/kill");
            await fetch(killUrl, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ multiplexer: muxType, session: muxSession }),
            });
          } catch {
            // best-effort — mux may already be dead
          }
        }

        // Step 3: Delete the JSONL file
        const deleteUrl = getAgentUrl(machine, "/api/delete-session");
        const agentResp = await fetch(deleteUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ sessionId: body.sessionId }),
        });

        if (!agentResp.ok) {
          const errText = await agentResp.text();
          return Response.json({ error: errText || "Delete failed" }, { status: 502 });
        }

        // Step 4: Clean up server-side state (session names, etc.)
        renameSession(body.machineId, body.sessionId, "");

        return Response.json({ ok: true });
      } catch (err) {
        log.error(`delete: failed: ${err instanceof Error ? err.message : String(err)}`);
        return Response.json({ error: "Failed to delete session" }, { status: 500 });
      }
    }

    // API: send text to a session's multiplexer
    if (url.pathname === "/api/sessions/send" && req.method === "POST") {
      try {
        const body = (await req.json()) as {
          machineId: string;
          multiplexer: string;
          session: string;
          text: string;
          agentType?: string;
        };

        const machine = getMachine(body.machineId);
        if (!machine || !machine.terminalPort) {
          return Response.json({ error: "Machine not found" }, { status: 404 });
        }

        const agentUrl = getAgentUrl(machine, "/api/send");

        const agentResp = await fetch(agentUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            multiplexer: body.multiplexer,
            agentType: body.agentType,
            session: body.session,
            text: body.text,
          }),
        });

        if (!agentResp.ok) {
          return Response.json({ error: "Agent send failed" }, { status: 502 });
        }
        return Response.json({ ok: true });
      } catch (err) {
        log.error(`send: failed: ${err instanceof Error ? err.message : String(err)}`);
        return Response.json({ error: "Failed to send" }, { status: 500 });
      }
    }

    // API: reconnect agent in an existing mux session (proxy to agent)
    if (url.pathname === "/api/sessions/reconnect" && req.method === "POST") {
      try {
        const body = (await req.json()) as {
          machineId: string;
          multiplexer: string;
          session: string;
          sessionId: string;
          agentType?: string;
        };

        const machine = getMachine(body.machineId);
        if (!machine || !machine.terminalPort) {
          return Response.json({ error: "Machine not found" }, { status: 404 });
        }

        const settings = getSettings();

        const agentUrl = getAgentUrl(machine, "/api/reconnect");

        const agentResp = await fetch(agentUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            multiplexer: body.multiplexer,
            session: body.session,
            sessionId: body.sessionId,
            agentType: body.agentType || settings.defaultAgentType,
            model: settings.defaultModel,
          }),
        });

        if (!agentResp.ok) {
          const errText = await agentResp.text();
          return Response.json({ error: errText || "Agent reconnect failed" }, { status: 502 });
        }
        return Response.json({ ok: true });
      } catch (err) {
        log.error(`reconnect: failed: ${err instanceof Error ? err.message : String(err)}`);
        return Response.json({ error: "Failed to reconnect" }, { status: 500 });
      }
    }

    // API: get settings
    if (url.pathname === "/api/settings" && req.method === "GET") {
      return Response.json(getSettings());
    }

    // API: update settings
    if (url.pathname === "/api/settings" && req.method === "POST") {
      try {
        const body: Partial<Settings> = await req.json();
        const updated = updateSettings(body);
        return Response.json(updated);
      } catch (err) {
        log.warn(`settings: invalid payload: ${err instanceof Error ? err.message : String(err)}`);
        return Response.json({ error: "Invalid payload" }, { status: 400 });
      }
    }

    // API: launch a new agent session
    if (url.pathname === "/api/agents/launch" && req.method === "POST") {
      try {
        const body: LaunchAgentRequest = await req.json();
        const machine = getMachine(body.machineId);
        if (!machine || !machine.terminalPort) {
          return Response.json({ error: "Machine not found" }, { status: 404 });
        }

        const settings = getSettings();
        const mux = body.multiplexer || settings.defaultMultiplexer;

        const agentUrl = getAgentUrl(machine, "/api/launch");

        const agentResp = await fetch(agentUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            sessionName: body.sessionName,
            projectDir: body.projectDir,
            agentType: body.agentType || settings.defaultAgentType,
            multiplexer: mux,
            zellijLayout: settings.zellijLayout,
            model: settings.defaultModel,
            autonomous: body.autonomous,
          }),
        });

        if (!agentResp.ok) {
          const errText = await agentResp.text();
          return Response.json({ error: errText || "Agent launch failed" }, { status: 502 });
        }

        // Add a pending session so the dashboard shows it immediately
        // (before the next heartbeat discovers the real session)
        addPendingSession(body.machineId, body.sessionName, body.projectDir, mux);
        broadcastToClients({
          type: "machines_update",
          payload: getAllMachines(),
        });

        return Response.json({
          ok: true,
          sessionName: body.sessionName,
          multiplexer: mux,
        });
      } catch (err) {
        log.error(`launch: failed: ${err instanceof Error ? err.message : String(err)}`);
        return Response.json({ error: "Failed to launch agent" }, { status: 500 });
      }
    }

    // API: resume an idle claude session in a new multiplexer session
    if (url.pathname === "/api/agents/resume" && req.method === "POST") {
      try {
        const body: ResumeAgentRequest = await req.json();
        const machine = getMachine(body.machineId);
        if (!machine || !machine.terminalPort) {
          return Response.json({ error: "Machine not found" }, { status: 404 });
        }

        const settings = getSettings();

        const agentUrl = getAgentUrl(machine, "/api/resume");

        // Pick the best name for the new multiplexer session:
        // 1. Saved custom name (user-renamed or auto-populated from multiplexer)
        // 2. Claude Code slug (e.g. "bold-river-sunset")
        // 3. Last resort: session ID prefix
        const savedName = getSavedSessionName(body.sessionId);
        const slug = getSessionSlug(body.machineId, body.sessionId);
        const rawName = savedName || slug || body.sessionId.slice(0, 8);
        const sessionName = rawName.replace(/[^a-zA-Z0-9._-]/g, "-").slice(0, 50);

        const agentResp = await fetch(agentUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            sessionName,
            sessionId: body.sessionId,
            projectDir: body.projectDir,
            agentType: body.agentType || settings.defaultAgentType,
            multiplexer: settings.defaultMultiplexer,
            zellijLayout: settings.zellijLayout,
            model: settings.defaultModel,
            autonomous: body.autonomous,
          }),
        });

        if (!agentResp.ok) {
          const errText = await agentResp.text();
          return Response.json({ error: errText || "Agent resume failed" }, { status: 502 });
        }
        return Response.json({
          ok: true,
          sessionName,
          multiplexer: settings.defaultMultiplexer,
        });
      } catch (err) {
        log.error(`resume: failed: ${err instanceof Error ? err.message : String(err)}`);
        return Response.json({ error: "Failed to resume agent" }, { status: 500 });
      }
    }

    // API: get all machines
    if (url.pathname === "/api/machines" && req.method === "GET") {
      return Response.json(getAllMachines());
    }

    // --- Remote nodes API ---

    // API: list all nodes
    if (url.pathname === "/api/nodes" && req.method === "GET") {
      return Response.json(getAllNodes());
    }

    // API: create a node
    if (url.pathname === "/api/nodes" && req.method === "POST") {
      try {
        const body: CreateNodeRequest = await req.json();
        if (!body.name || !body.host || !body.user || !body.sshKeyPath) {
          return Response.json({ error: "Missing required fields: name, host, user, sshKeyPath" }, { status: 400 });
        }
        const node = createNode(body);
        return Response.json(node, { status: 201 });
      } catch (err) {
        log.warn(`create node: invalid payload: ${err instanceof Error ? err.message : String(err)}`);
        return Response.json({ error: "Invalid payload" }, { status: 400 });
      }
    }

    // API: update a node
    if (url.pathname.startsWith("/api/nodes/") && req.method === "PUT") {
      const nodeId = url.pathname.split("/")[3];
      try {
        const body: UpdateNodeRequest = await req.json();
        const node = updateNode(nodeId, body);
        if (!node) return Response.json({ error: "Node not found" }, { status: 404 });
        return Response.json(node);
      } catch (err) {
        log.warn(`update node: invalid payload: ${err instanceof Error ? err.message : String(err)}`);
        return Response.json({ error: "Invalid payload" }, { status: 400 });
      }
    }

    // API: delete a node
    if (url.pathname.startsWith("/api/nodes/") && req.method === "DELETE") {
      const nodeId = url.pathname.split("/")[3];
      // Disconnect first if connected
      try {
        await disconnectNode(nodeId);
      } catch (err) {
        log.debug(
          `delete node: pre-disconnect failed (continuing): ${err instanceof Error ? err.message : String(err)}`,
        );
      }
      const ok = deleteNode(nodeId);
      if (!ok) return Response.json({ error: "Node not found" }, { status: 404 });
      return Response.json({ ok: true });
    }

    // API: connect to a node
    if (url.pathname.match(/^\/api\/nodes\/[^/]+\/connect$/) && req.method === "POST") {
      const nodeId = url.pathname.split("/")[3];
      const node = getNode(nodeId);
      if (!node) return Response.json({ error: "Node not found" }, { status: 404 });
      // Connect in background — don't block the request
      connectNode(nodeId).catch((err) => {
        log.error(
          `connect node: ${node.name} background connect failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      });
      return Response.json({ ok: true, status: "connecting" });
    }

    // API: disconnect from a node
    if (url.pathname.match(/^\/api\/nodes\/[^/]+\/disconnect$/) && req.method === "POST") {
      const nodeId = url.pathname.split("/")[3];
      try {
        await disconnectNode(nodeId);
        return Response.json({ ok: true });
      } catch (err) {
        log.error(
          `disconnect: failed for node=${nodeId.slice(0, 8)}: ${err instanceof Error ? err.message : String(err)}`,
        );
        return Response.json({ error: "Failed to disconnect" }, { status: 500 });
      }
    }

    // API: test SSH connection (without saving or connecting)
    if (url.pathname === "/api/nodes/test" && req.method === "POST") {
      try {
        const body = (await req.json()) as { host: string; port?: number; user: string; sshKeyPath: string };
        if (!body.host || !body.user || !body.sshKeyPath) {
          return Response.json({ error: "Missing host, user, or sshKeyPath" }, { status: 400 });
        }
        const result = await testNodeConnection({
          host: body.host,
          port: body.port ?? 22,
          user: body.user,
          sshKeyPath: body.sshKeyPath,
        });
        return Response.json(result);
      } catch (err) {
        log.error(`test node: failed: ${err instanceof Error ? err.message : String(err)}`);
        return Response.json({ error: "Test failed" }, { status: 500 });
      }
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
        log.debug(`ws: dashboard client connected (total=${wsClients.size + 1})`);
        const client = {
          ws,
          send: (d: string) => ws.send(d),
        };
        wsClients.add(client);
        ws.send(
          JSON.stringify({
            type: "machines_update",
            payload: getAllMachines(),
          }),
        );
        return;
      }

      if (data.type === "terminal") {
        const { agentHost, agentPort, session, multiplexer, cols, rows } = data as {
          agentHost: string;
          agentPort: number;
          session: string;
          multiplexer: string;
          cols: string;
          rows: string;
        };

        // Connect to the agent's terminal WebSocket
        const agentUrl =
          `ws://${agentHost}:${agentPort}/ws/terminal` +
          `?session=${encodeURIComponent(session)}` +
          `&multiplexer=${multiplexer}` +
          `&cols=${cols}&rows=${rows}`;

        const agentWs = new WebSocket(agentUrl);

        agentWs.binaryType = "arraybuffer";

        agentWs.onopen = () => {
          log.debug(`ws: terminal proxy established for session=${session}`);
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
          log.warn(`ws: terminal proxy error for session=${session} agent=${agentHost}:${agentPort}`);
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

log.info(`listening on http://0.0.0.0:${PORT} — dashboard: http://localhost:${PORT}`);

// Auto-connect to nodes marked with autoConnect
connectAutoNodes();
