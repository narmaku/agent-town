import { join } from "node:path";
import type { Subprocess } from "bun";

const PTY_HELPER = join(import.meta.dir, "pty-helper.py");

interface TerminalSession {
  process: Subprocess;
  machineId: string;
  identifier: string;
}

const activeTerminals = new Map<unknown, TerminalSession>();

function buildAttachCommand(
  multiplexer: "zellij" | "tmux",
  sessionName: string
): string[] {
  if (multiplexer === "zellij") {
    return ["zellij", "attach", sessionName];
  }
  return ["tmux", "attach-session", "-t", sessionName];
}

export function startTerminalServer(port: number, machineId: string) {
  const server = Bun.serve({
    port,
    hostname: "0.0.0.0",

    fetch(req, server) {
      const url = new URL(req.url);
      if (url.pathname === "/ws/terminal") {
        const upgraded = server.upgrade(req, {
          data: {
            multiplexer: url.searchParams.get("multiplexer") || "zellij",
            session: url.searchParams.get("session") || "",
            cols: parseInt(url.searchParams.get("cols") || "120"),
            rows: parseInt(url.searchParams.get("rows") || "40"),
          },
        });
        if (!upgraded) {
          return new Response("WebSocket upgrade failed", { status: 400 });
        }
        return undefined;
      }
      return new Response("Agent Town Terminal Server", { status: 200 });
    },

    websocket: {
      open(ws) {
        const { multiplexer, session, cols, rows } = ws.data as {
          multiplexer: "zellij" | "tmux";
          session: string;
          cols: number;
          rows: number;
        };

        if (!session) {
          ws.send(JSON.stringify({ type: "error", message: "No session specified" }));
          ws.close();
          return;
        }

        const cmd = buildAttachCommand(multiplexer, session);

        // Strip multiplexer and Claude env vars so attach works even when
        // the agent itself runs inside a zellij/tmux/claude session
        const cleanEnv = { ...process.env };
        delete cleanEnv.ZELLIJ;
        delete cleanEnv.ZELLIJ_SESSION_NAME;
        delete cleanEnv.ZELLIJ_PANE_ID;
        delete cleanEnv.TMUX;
        delete cleanEnv.TMUX_PANE;
        delete cleanEnv.CLAUDECODE;

        // Ensure proper terminal capabilities for xterm.js
        cleanEnv.TERM = "xterm-256color";
        cleanEnv.COLORTERM = "truecolor";
        cleanEnv.LANG = cleanEnv.LANG || "en_US.UTF-8";

        const proc = Bun.spawn(
          ["python3", PTY_HELPER, String(cols), String(rows), ...cmd],
          {
            stdin: "pipe",
            stdout: "pipe",
            stderr: "pipe",
            env: cleanEnv,
          }
        );

        activeTerminals.set(ws, { process: proc, machineId, identifier: session });

        // Read stdout and send to WebSocket
        (async () => {
          const reader = proc.stdout.getReader();
          try {
            while (true) {
              const { done, value } = await reader.read();
              if (done) break;
              try {
                ws.send(value);
              } catch {
                break;
              }
            }
          } catch {
            // process ended
          }
          try {
            ws.close();
          } catch {
            // already closed
          }
        })();

        // Read stderr for debugging
        (async () => {
          const reader = proc.stderr.getReader();
          try {
            while (true) {
              const { done, value } = await reader.read();
              if (done) break;
              console.error(`[terminal:${session}] ${new TextDecoder().decode(value)}`);
            }
          } catch {
            // process ended
          }
        })();
      },

      message(ws, message) {
        const terminal = activeTerminals.get(ws);
        if (!terminal) return;

        if (typeof message === "string") {
          try {
            const parsed = JSON.parse(message);
            if (parsed.type === "resize") {
              terminal.process.stdin.write(
                JSON.stringify({ type: "resize", cols: parsed.cols, rows: parsed.rows }) + "\n"
              );
              return;
            }
          } catch {
            // Not JSON, treat as terminal input
          }
          terminal.process.stdin.write(message);
        } else {
          terminal.process.stdin.write(message as Uint8Array);
        }
      },

      close(ws) {
        const terminal = activeTerminals.get(ws);
        if (terminal) {
          terminal.process.kill();
          activeTerminals.delete(ws);
        }
      },
    },
  });

  console.log(`  Terminal:  ws://0.0.0.0:${port}/ws/terminal`);
  return server;
}
