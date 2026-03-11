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

    async fetch(req, server) {
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
      // HTTP endpoint: launch a new multiplexer session with claude
      if (url.pathname === "/api/launch" && req.method === "POST") {
        try {
          const body = await req.json() as {
            sessionName: string;
            projectDir: string;
            multiplexer: "zellij" | "tmux";
            zellijLayout?: string;
            model?: string;
          };

          if (!body.sessionName || !body.projectDir) {
            return Response.json({ error: "Missing sessionName or projectDir" }, { status: 400 });
          }

          const cleanEnv = { ...process.env };
          delete cleanEnv.ZELLIJ;
          delete cleanEnv.ZELLIJ_SESSION_NAME;
          delete cleanEnv.ZELLIJ_PANE_ID;
          delete cleanEnv.TMUX;
          delete cleanEnv.TMUX_PANE;
          delete cleanEnv.CLAUDECODE;

          const claudeCmd = body.model ? `claude --model ${body.model}` : "claude";

          if (body.multiplexer === "tmux") {
            // Create tmux session in the project directory
            const newSession = Bun.spawn(
              ["tmux", "new-session", "-d", "-s", body.sessionName, "-c", body.projectDir],
              { env: cleanEnv, stdout: "pipe", stderr: "pipe" }
            );
            await newSession.exited;
            if (newSession.exitCode !== 0) {
              const stderr = await new Response(newSession.stderr).text();
              return Response.json({ error: `tmux new-session failed: ${stderr}` }, { status: 500 });
            }

            // Send claude command
            const sendKeys = Bun.spawn(
              ["tmux", "send-keys", "-t", body.sessionName, claudeCmd, "Enter"],
              { env: cleanEnv, stdout: "pipe", stderr: "pipe" }
            );
            await sendKeys.exited;

            return Response.json({ ok: true });
          }

          // Zellij: create session with layout
          const zellijArgs = ["zellij", "-s", body.sessionName];
          if (body.zellijLayout) {
            zellijArgs.push("-n", body.zellijLayout);
          }

          const zellijProc = Bun.spawn(zellijArgs, {
            env: cleanEnv,
            stdout: "pipe",
            stderr: "pipe",
            cwd: body.projectDir,
          });

          // Don't await zellij — it may stay running. Give it time to start.
          await new Promise((r) => setTimeout(r, 1500));

          // Send cd + claude command via write-chars
          const fullCmd = `cd ${body.projectDir} && ${claudeCmd}`;
          const writeChars = Bun.spawn(
            ["zellij", "--session", body.sessionName, "action", "write-chars", fullCmd],
            { env: cleanEnv, stdout: "pipe", stderr: "pipe" }
          );
          await writeChars.exited;

          // Send Enter
          await new Promise((r) => setTimeout(r, 200));
          const writeEnter = Bun.spawn(
            ["zellij", "--session", body.sessionName, "action", "write", "13"],
            { env: cleanEnv, stdout: "pipe", stderr: "pipe" }
          );
          await writeEnter.exited;

          return Response.json({ ok: true });
        } catch (err) {
          return Response.json({ error: "Failed to launch session" }, { status: 500 });
        }
      }

      // HTTP endpoint: kill/close a multiplexer session
      if (url.pathname === "/api/kill" && req.method === "POST") {
        try {
          const body = await req.json() as {
            multiplexer: "zellij" | "tmux";
            session: string;
          };

          if (!body.session) {
            return Response.json({ error: "Missing session" }, { status: 400 });
          }

          const cleanEnv = { ...process.env };
          delete cleanEnv.ZELLIJ;
          delete cleanEnv.ZELLIJ_SESSION_NAME;
          delete cleanEnv.TMUX;
          delete cleanEnv.CLAUDECODE;

          if (body.multiplexer === "tmux") {
            const proc = Bun.spawn(
              ["tmux", "kill-session", "-t", body.session],
              { env: cleanEnv, stdout: "pipe", stderr: "pipe" }
            );
            await proc.exited;
          } else {
            const proc = Bun.spawn(
              ["zellij", "delete-session", body.session, "--force"],
              { env: cleanEnv, stdout: "pipe", stderr: "pipe" }
            );
            await proc.exited;
          }

          return Response.json({ ok: true });
        } catch {
          return Response.json({ error: "Failed to kill session" }, { status: 500 });
        }
      }

      // HTTP endpoint: send text to a multiplexer session
      if (url.pathname === "/api/send" && req.method === "POST") {
        try {
          const body = await req.json() as {
            multiplexer: "zellij" | "tmux";
            session: string;
            text: string;
          };

          if (!body.session || !body.text) {
            return Response.json({ error: "Missing session or text" }, { status: 400 });
          }

          const cleanEnv = { ...process.env };
          delete cleanEnv.ZELLIJ;
          delete cleanEnv.ZELLIJ_SESSION_NAME;
          delete cleanEnv.TMUX;
          delete cleanEnv.CLAUDECODE;

          if (body.multiplexer === "tmux") {
            // tmux send-keys works reliably
            const proc = Bun.spawn(
              ["tmux", "send-keys", "-t", body.session, body.text, "Enter"],
              { env: cleanEnv, stdout: "pipe", stderr: "pipe" }
            );
            await proc.exited;
            return Response.json({ ok: true });
          }

          // For zellij, use write-chars + write 13 (Enter)
          const writeChars = Bun.spawn(
            ["zellij", "--session", body.session, "action", "write-chars", body.text],
            { env: cleanEnv, stdout: "pipe", stderr: "pipe" }
          );
          await writeChars.exited;

          // Small delay then send Enter
          await new Promise((r) => setTimeout(r, 200));
          const writeEnter = Bun.spawn(
            ["zellij", "--session", body.session, "action", "write", "13"],
            { env: cleanEnv, stdout: "pipe", stderr: "pipe" }
          );
          await writeEnter.exited;

          return Response.json({ ok: true });
        } catch {
          return Response.json({ error: "Failed to send" }, { status: 500 });
        }
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
