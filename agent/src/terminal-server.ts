import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { type AgentType, buildShellCommand, createLogger, truncateId } from "@agent-town/shared";
import type { Server, Subprocess } from "bun";
import { clearHookSession, updateHookState } from "./hook-store";
import { getAllProviders, getProvider } from "./providers/registry";
import { getSessionMessages } from "./session-messages";

const log = createLogger("terminal");

const PTY_HELPER = join(import.meta.dir, "pty-helper.py");

// --- Timing constants ---
const TRUST_PROMPT_DELAY_MS = 3000;
const AUTONOMOUS_DISCLAIMER_DELAY_MS = 2000;
const INITIAL_MESSAGE_DELAY_MS = 3000;
const SESSION_READY_POLL_MS = 300;
const SESSION_READY_TIMEOUT_MS = 5000;
const PTY_INIT_DELAY_MS = 1000;
const PTY_INPUT_BASE_DELAY_MS = 500;
const BRACKETED_PASTE_DELAY_MS = 100;
const BACKUP_ENTER_DELAY_MS = 300;

// --- Terminal defaults ---
const DEFAULT_TERMINAL_COLS = 120;
const DEFAULT_TERMINAL_ROWS = 40;

// --- Input validation ---

const SAFE_NAME_RE = /^[a-zA-Z0-9._-]+$/;
const SAFE_MODEL_RE = /^[a-zA-Z0-9._:/-]+$/;

export function validateSessionName(name: string): string | null {
  if (!name || name.length > 100) return "Session name must be 1-100 characters";
  if (!SAFE_NAME_RE.test(name)) return "Session name contains invalid characters (allowed: a-z A-Z 0-9 . _ -)";
  return null;
}

export function validateProjectDir(dir: string): string | null {
  if (!dir) return "Project directory is required";
  if (!dir.startsWith("/")) return "Project directory must be an absolute path";
  // Canonicalize and reject if the resolved path differs (catches .., //, ., trailing /)
  // TODO: path.resolve() is lexical only — does not resolve symlinks.
  // Consider using fs.realpathSync() if symlink-based traversal becomes a concern.
  const canonical = resolve(dir);
  if (canonical !== dir) return "Project directory must be a canonical absolute path (no .., //, or trailing /)";
  return null;
}

export function validateModel(model: string): string | null {
  if (!SAFE_MODEL_RE.test(model)) return "Model name contains invalid characters";
  return null;
}

export function validateSessionId(id: string): string | null {
  if (!id) return "Session ID is required";
  // Claude Code: UUIDs (hex + hyphens). OpenCode: ses_<alphanumeric>.
  if (!/^[a-zA-Z0-9_-]+$/i.test(id)) return "Session ID contains invalid characters";
  return null;
}

// --- Environment helpers ---

function cleanMultiplexerEnv(): Record<string, string | undefined> {
  const env = { ...process.env };
  delete env.ZELLIJ;
  delete env.ZELLIJ_SESSION_NAME;
  delete env.ZELLIJ_PANE_ID;
  delete env.TMUX;
  delete env.TMUX_PANE;
  delete env.CLAUDECODE;
  return env;
}

/**
 * Remove any EXITED zellij session with the given name.
 * Zellij keeps killed sessions in (EXITED) state, blocking creation
 * of a new session with the same name.
 */
/**
 * Clean up before creating a zellij session:
 * 1. Delete any EXITED zellij session with the same name
 * 2. Stop any lingering systemd scope units from previous sessions
 */
async function cleanupBeforeZellijCreate(name: string, env: Record<string, string | undefined>): Promise<void> {
  // Remove EXITED zellij session remnant
  const del = Bun.spawn(["zellij", "delete-session", name, "--force"], {
    env,
    stdout: "pipe",
    stderr: "pipe",
  });
  await del.exited;

  // Stop any lingering systemd scope units with matching name prefix
  if (systemdRunAvailable) {
    const list = Bun.spawn(["systemctl", "--user", "list-units", "--type=scope", "--plain", "--no-legend"], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const output = await new Response(list.stdout).text();
    await list.exited;

    for (const line of output.split("\n")) {
      const unit = line.trim().split(/\s+/)[0];
      if (unit?.startsWith(`agent-town-mux-${name}`)) {
        const stop = Bun.spawn(["systemctl", "--user", "stop", unit], {
          stdout: "pipe",
          stderr: "pipe",
        });
        await stop.exited;
        log.debug(`cleanup: stopped lingering scope ${unit}`);
      }
    }
  }
}

function cleanTerminalEnv(): Record<string, string | undefined> {
  const env = cleanMultiplexerEnv();
  env.TERM = "xterm-256color";
  env.COLORTERM = "truecolor";
  env.LANG = env.LANG || "en_US.UTF-8";
  return env;
}

// --- Cgroup isolation ---
//
// Launched multiplexer sessions must NOT be children of the agent-town
// systemd service. If they are, `systemctl restart agent-town` kills
// every zellij/tmux session (and Claude + anything it spawned).
//
// systemd-run --user --scope creates a separate cgroup scope so the
// launched session survives agent restarts.

let systemdRunAvailable: boolean | null = null;

async function checkSystemdRun(): Promise<boolean> {
  if (systemdRunAvailable !== null) return systemdRunAvailable;
  try {
    // Test actual scope creation, not just --version.
    // --version succeeds even when the user session isn't available
    // (e.g., agent started via SSH nohup without a login session).
    const proc = Bun.spawn(["systemd-run", "--user", "--scope", "--unit=agent-town-test-scope", "true"], {
      stdout: "pipe",
      stderr: "pipe",
    });
    await proc.exited;
    systemdRunAvailable = proc.exitCode === 0;
  } catch (err) {
    log.debug(`systemd-run check failed: ${err instanceof Error ? err.message : String(err)}`);
    systemdRunAvailable = false;
  }
  if (systemdRunAvailable) {
    log.info("cgroup isolation: systemd-run --scope works");
  } else {
    log.info("cgroup isolation: systemd-run --scope not available, using direct spawn");
  }
  return systemdRunAvailable;
}

// Check on module load (non-blocking)
checkSystemdRun();

/**
 * Wrap a command in systemd-run --scope so it runs in its own cgroup,
 * surviving agent-town service restarts. Falls back to direct spawn
 * if systemd-run is not available (e.g., macOS).
 */
function buildScopeCommand(sessionName: string, cmd: string[]): string[] {
  if (!systemdRunAvailable) return cmd;
  // Use a timestamp suffix to avoid conflicts with lingering scope units
  // from previous sessions with the same name.
  const suffix = Date.now().toString(36);
  const scopeUnit = `agent-town-mux-${sessionName}-${suffix}`;
  return ["systemd-run", "--user", "--scope", `--unit=${scopeUnit}`, ...cmd];
}

interface TerminalSession {
  process: Subprocess;
  machineId: string;
  identifier: string;
}

const activeTerminals = new Map<unknown, TerminalSession>();

// Tracks multiplexer session renames: oldName → newName.
// When a session is renamed via the dashboard, the ZELLIJ_SESSION_NAME
// env var in the shell process stays stale. This map lets the process
// mapper resolve the stale name to the current name.
// Persisted to disk so it survives agent restarts.
const RENAME_MAP_DIR = join(homedir(), ".agent-town");
const RENAME_MAP_FILE = join(RENAME_MAP_DIR, "rename-map.json");

const sessionRenameMap = new Map<string, string>();

function loadRenameMap(): void {
  try {
    const data = readFileSync(RENAME_MAP_FILE, "utf-8");
    const parsed = JSON.parse(data) as Record<string, string>;
    for (const [key, value] of Object.entries(parsed)) {
      sessionRenameMap.set(key, value);
    }
    log.debug(`loaded ${sessionRenameMap.size} rename mapping(s)`);
  } catch (err) {
    log.debug(`rename map not loaded: ${err instanceof Error ? err.message : String(err)}`);
  }
}

function saveRenameMap(): void {
  try {
    mkdirSync(RENAME_MAP_DIR, { recursive: true });
    const obj: Record<string, string> = {};
    for (const [key, value] of sessionRenameMap) {
      obj[key] = value;
    }
    writeFileSync(RENAME_MAP_FILE, JSON.stringify(obj, null, 2));
  } catch (err) {
    log.warn(`failed to save rename map: ${err instanceof Error ? err.message : String(err)}`);
  }
}

// Load persisted renames on startup
loadRenameMap();

/**
 * Add a rename mapping (in-memory only, for testing).
 */
export function addRenameMapping(oldName: string, newName: string): void {
  sessionRenameMap.set(oldName, newName);
}

/**
 * Clear all rename mappings (in-memory only, for testing).
 * Does NOT touch the persisted file — tests must not wipe production data.
 */
export function clearRenameMappings(): void {
  sessionRenameMap.clear();
}

/**
 * Resolve a potentially stale multiplexer session name to its
 * current name by following the rename chain.
 */
export function resolveSessionName(name: string): string {
  let resolved = name;
  const seen = new Set<string>();
  while (sessionRenameMap.has(resolved) && !seen.has(resolved)) {
    seen.add(resolved);
    resolved = sessionRenameMap.get(resolved)!;
  }
  return resolved;
}

function buildAttachCommand(multiplexer: "zellij" | "tmux", sessionName: string): string[] {
  if (multiplexer === "zellij") {
    return ["zellij", "attach", sessionName];
  }
  return ["tmux", "attach-session", "-t", sessionName];
}

// --- Send-text helpers ---

/**
 * Send text via PTY attachment to a multiplexer session.
 * Uses bracketed paste for TUI apps (OpenCode) and direct write
 * for CLI prompts (Claude Code).
 */
async function sendViaPTY(
  attachCmd: string[],
  text: string,
  agentType: AgentType | undefined,
  cleanEnv: Record<string, string | undefined>,
): Promise<void> {
  const proc = Bun.spawn(["python3", PTY_HELPER, "120", "40", ...attachCmd], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    env: cleanEnv,
  });

  await new Promise((r) => setTimeout(r, PTY_INIT_DELAY_MS));

  if (agentType === "opencode") {
    // Bracketed paste for Bubble Tea TUI — handles the entire paste
    // as one event instead of individual keystrokes.
    // \x1b[200~ = paste start, \x1b[201~ = paste end
    proc.stdin.write(`\x1b[200~${text}\x1b[201~`);
    await new Promise((r) => setTimeout(r, BRACKETED_PASTE_DELAY_MS));
    proc.stdin.write("\r");
  } else {
    // Claude Code: direct write to readline CLI prompt
    proc.stdin.write(`${text}\r`);
  }

  await new Promise((r) => setTimeout(r, PTY_INPUT_BASE_DELAY_MS));
  proc.kill();
}

/**
 * Send a backup Enter keystroke via native multiplexer command
 * in case the PTY carriage return was swallowed.
 */
async function sendBackupEnter(
  multiplexer: "zellij" | "tmux",
  session: string,
  cleanEnv: Record<string, string | undefined>,
): Promise<void> {
  await new Promise((r) => setTimeout(r, BACKUP_ENTER_DELAY_MS));
  if (multiplexer === "zellij") {
    const enter = Bun.spawn(["zellij", "--session", session, "action", "write", "13"], {
      env: cleanEnv,
      stdout: "pipe",
      stderr: "pipe",
    });
    await enter.exited;
  } else {
    const enter = Bun.spawn(["tmux", "send-keys", "-t", session, "Enter"], {
      env: cleanEnv,
      stdout: "pipe",
      stderr: "pipe",
    });
    await enter.exited;
  }
}

export function startTerminalServer(port: number, machineId: string): Server {
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
            cols: parseInt(url.searchParams.get("cols") || String(DEFAULT_TERMINAL_COLS), 10),
            rows: parseInt(url.searchParams.get("rows") || String(DEFAULT_TERMINAL_ROWS), 10),
          },
        });
        if (!upgraded) {
          return new Response("WebSocket upgrade failed", { status: 400 });
        }
        return undefined;
      }
      // HTTP endpoint: get paginated session messages from JSONL
      if (url.pathname === "/api/session-messages" && req.method === "GET") {
        const sessionId = url.searchParams.get("sessionId");
        const agentType = (url.searchParams.get("agentType") || "claude-code") as AgentType;
        const offset = parseInt(url.searchParams.get("offset") || "0", 10);
        const limit = parseInt(url.searchParams.get("limit") || "10", 10);

        if (!sessionId) {
          return Response.json({ error: "Missing sessionId" }, { status: 400 });
        }

        try {
          const result = await getSessionMessages(sessionId, offset, limit, agentType);
          return Response.json(result);
        } catch (err) {
          const message = err instanceof Error ? err.message : "Unknown error";
          const status = message === "Session not found" ? 404 : 500;
          return Response.json({ error: message }, { status });
        }
      }

      // HTTP endpoint: launch a new multiplexer session with an agent
      if (url.pathname === "/api/launch" && req.method === "POST") {
        try {
          const body = (await req.json()) as {
            sessionName: string;
            projectDir: string;
            multiplexer: "zellij" | "tmux";
            agentType?: AgentType;
            zellijLayout?: string;
            model?: string;
            autonomous?: boolean;
          };

          const agentType = body.agentType || "claude-code";
          const provider = getProvider(agentType);
          if (!provider) {
            return Response.json({ error: `Agent type "${agentType}" is not available` }, { status: 400 });
          }

          log.info(
            `launch: name=${body.sessionName} agent=${agentType} mux=${body.multiplexer} dir=${body.projectDir} model=${body.model || "default"} autonomous=${body.autonomous || false}`,
          );

          const nameErr = validateSessionName(body.sessionName);
          if (nameErr) return Response.json({ error: nameErr }, { status: 400 });

          const dirErr = validateProjectDir(body.projectDir);
          if (dirErr) return Response.json({ error: dirErr }, { status: 400 });

          if (body.model) {
            const modelErr = validateModel(body.model);
            if (modelErr) return Response.json({ error: modelErr }, { status: 400 });
          }

          const cleanEnv = cleanMultiplexerEnv();

          const agentParts = provider.buildLaunchCommand({
            model: body.model,
            autonomous: body.autonomous,
          });

          if (body.multiplexer === "tmux") {
            // Create tmux session in its own cgroup scope (survives agent restarts)
            const tmuxCmd = buildScopeCommand(body.sessionName, [
              "tmux",
              "new-session",
              "-d",
              "-s",
              body.sessionName,
              "-c",
              body.projectDir,
            ]);
            const newSession = Bun.spawn(tmuxCmd, {
              env: cleanEnv,
              stdout: "pipe",
              stderr: "pipe",
            });
            await newSession.exited;
            if (newSession.exitCode !== 0) {
              const stderr = await new Response(newSession.stderr).text();
              log.error(`tmux new-session failed: ${stderr}`);
              return Response.json({ error: "Failed to create multiplexer session" }, { status: 500 });
            }

            // Send agent command
            const agentCmd = buildShellCommand(agentParts);
            const sendKeys = Bun.spawn(["tmux", "send-keys", "-t", body.sessionName, agentCmd, "Enter"], {
              env: cleanEnv,
              stdout: "pipe",
              stderr: "pipe",
            });
            await sendKeys.exited;

            // Claude Code-specific post-launch: auto-accept trust prompt,
            // autonomous disclaimer, and send initial "hi" to trigger JSONL.
            // Other agents (OpenCode) have their own TUI and don't need this.
            if (agentType === "claude-code") {
              await new Promise((r) => setTimeout(r, TRUST_PROMPT_DELAY_MS));
              Bun.spawn(["tmux", "send-keys", "-t", body.sessionName, "Enter"], {
                env: cleanEnv,
                stdout: "pipe",
                stderr: "pipe",
              });

              if (body.autonomous) {
                await new Promise((r) => setTimeout(r, AUTONOMOUS_DISCLAIMER_DELAY_MS));
                Bun.spawn(["tmux", "send-keys", "-t", body.sessionName, "Enter"], {
                  env: cleanEnv,
                  stdout: "pipe",
                  stderr: "pipe",
                });
              }

              await new Promise((r) => setTimeout(r, INITIAL_MESSAGE_DELAY_MS));
              Bun.spawn(["tmux", "send-keys", "-t", body.sessionName, "hi", "Enter"], {
                env: cleanEnv,
                stdout: "pipe",
                stderr: "pipe",
              });
            }

            return Response.json({ ok: true });
          }

          // Clean up EXITED sessions and lingering scope units
          await cleanupBeforeZellijCreate(body.sessionName, cleanEnv);

          // Zellij: create session in its own cgroup scope (survives agent restarts)
          // Note: zellij -s panics with ENOTTY when spawned without a TTY,
          // but it still creates the session successfully.
          async function tryCreateZellijSession(layout?: string): Promise<boolean> {
            const args = ["zellij", "-s", body.sessionName];
            if (layout) args.push("-n", layout);
            Bun.spawn(buildScopeCommand(body.sessionName, args), {
              env: cleanEnv,
              stdout: "pipe",
              stderr: "pipe",
              cwd: body.projectDir,
            });
            let elapsed = 0;
            while (elapsed < SESSION_READY_TIMEOUT_MS) {
              await new Promise((r) => setTimeout(r, SESSION_READY_POLL_MS));
              elapsed += SESSION_READY_POLL_MS;
              const listProc = Bun.spawn(["zellij", "list-sessions", "--short"], {
                env: cleanEnv,
                stdout: "pipe",
                stderr: "pipe",
              });
              const listOutput = await new Response(listProc.stdout).text();
              await listProc.exited;
              if (listOutput.split("\n").some((l) => l.trim() === body.sessionName)) return true;
            }
            return false;
          }

          // Try with layout first, then without (layout may not exist on remote machines)
          let sessionReady = await tryCreateZellijSession(body.zellijLayout);
          if (!sessionReady && body.zellijLayout) {
            log.warn(`launch: layout "${body.zellijLayout}" failed, retrying without layout`);
            sessionReady = await tryCreateZellijSession();
          }

          if (!sessionReady) {
            return Response.json(
              { error: `Zellij session "${body.sessionName}" did not start within ${SESSION_READY_TIMEOUT_MS}ms` },
              { status: 500 },
            );
          }

          // Send cd + agent command via write-chars (include \n to execute)
          const fullCmd = `${buildShellCommand(agentParts, body.projectDir)}\n`;
          const writeChars = Bun.spawn(["zellij", "--session", body.sessionName, "action", "write-chars", fullCmd], {
            env: cleanEnv,
            stdout: "pipe",
            stderr: "pipe",
          });
          await writeChars.exited;

          // Claude Code-specific post-launch: auto-accept trust prompt,
          // autonomous disclaimer, and send initial "hi" to trigger JSONL.
          if (agentType === "claude-code") {
            await new Promise((r) => setTimeout(r, TRUST_PROMPT_DELAY_MS));
            Bun.spawn(["zellij", "--session", body.sessionName, "action", "write-chars", "\n"], {
              env: cleanEnv,
              stdout: "pipe",
              stderr: "pipe",
            });

            if (body.autonomous) {
              await new Promise((r) => setTimeout(r, AUTONOMOUS_DISCLAIMER_DELAY_MS));
              Bun.spawn(["zellij", "--session", body.sessionName, "action", "write-chars", "\n"], {
                env: cleanEnv,
                stdout: "pipe",
                stderr: "pipe",
              });
            }

            await new Promise((r) => setTimeout(r, INITIAL_MESSAGE_DELAY_MS));
            Bun.spawn(["zellij", "--session", body.sessionName, "action", "write-chars", "hi\n"], {
              env: cleanEnv,
              stdout: "pipe",
              stderr: "pipe",
            });
          }

          return Response.json({ ok: true });
        } catch (err) {
          log.error(`launch failed: ${err instanceof Error ? err.message : String(err)}`);
          const message = err instanceof Error ? err.message : String(err);
          return Response.json({ error: `Failed to launch session: ${message}` }, { status: 500 });
        }
      }

      // HTTP endpoint: resume an existing session in a new multiplexer session
      if (url.pathname === "/api/resume" && req.method === "POST") {
        try {
          const body = (await req.json()) as {
            sessionName: string;
            sessionId: string;
            projectDir: string;
            multiplexer: "zellij" | "tmux";
            agentType?: AgentType;
            zellijLayout?: string;
            model?: string;
            autonomous?: boolean;
          };

          const agentType = body.agentType || "claude-code";
          const provider = getProvider(agentType);
          if (!provider) {
            return Response.json({ error: `Agent type "${agentType}" is not available` }, { status: 400 });
          }

          log.info(
            `resume: session=${truncateId(body.sessionId)} agent=${agentType} name=${body.sessionName} mux=${body.multiplexer} dir=${body.projectDir}`,
          );

          const nameErr = validateSessionName(body.sessionName);
          if (nameErr) return Response.json({ error: nameErr }, { status: 400 });

          const sidErr = validateSessionId(body.sessionId);
          if (sidErr) return Response.json({ error: sidErr }, { status: 400 });

          const dirErr = validateProjectDir(body.projectDir);
          if (dirErr) return Response.json({ error: dirErr }, { status: 400 });

          if (body.model) {
            const modelErr = validateModel(body.model);
            if (modelErr) return Response.json({ error: modelErr }, { status: 400 });
          }

          const cleanEnv = cleanMultiplexerEnv();

          const agentParts = provider.buildResumeCommand({
            sessionId: body.sessionId,
            model: body.model,
            autonomous: body.autonomous,
          });

          if (body.multiplexer === "tmux") {
            // Create tmux session in its own cgroup scope (survives agent restarts)
            const tmuxCmd = buildScopeCommand(body.sessionName, [
              "tmux",
              "new-session",
              "-d",
              "-s",
              body.sessionName,
              "-c",
              body.projectDir,
            ]);
            const newSession = Bun.spawn(tmuxCmd, {
              env: cleanEnv,
              stdout: "pipe",
              stderr: "pipe",
            });
            await newSession.exited;
            if (newSession.exitCode !== 0) {
              const stderr = await new Response(newSession.stderr).text();
              log.error(`tmux new-session failed: ${stderr}`);
              return Response.json({ error: "Failed to create multiplexer session" }, { status: 500 });
            }

            const agentCmd = buildShellCommand(agentParts);
            Bun.spawn(["tmux", "send-keys", "-t", body.sessionName, agentCmd, "Enter"], {
              env: cleanEnv,
              stdout: "pipe",
              stderr: "pipe",
            });

            if (agentType === "claude-code") {
              await new Promise((r) => setTimeout(r, TRUST_PROMPT_DELAY_MS));
              Bun.spawn(["tmux", "send-keys", "-t", body.sessionName, "Enter"], {
                env: cleanEnv,
                stdout: "pipe",
                stderr: "pipe",
              });

              if (body.autonomous) {
                await new Promise((r) => setTimeout(r, AUTONOMOUS_DISCLAIMER_DELAY_MS));
                Bun.spawn(["tmux", "send-keys", "-t", body.sessionName, "Enter"], {
                  env: cleanEnv,
                  stdout: "pipe",
                  stderr: "pipe",
                });
              }
            }

            return Response.json({ ok: true });
          }

          // Clean up EXITED sessions and lingering scope units
          await cleanupBeforeZellijCreate(body.sessionName, cleanEnv);

          // Create zellij session — try with layout, fallback without
          async function tryCreateZellijSession2(layout?: string): Promise<boolean> {
            const args = ["zellij", "-s", body.sessionName];
            if (layout) args.push("-n", layout);
            Bun.spawn(buildScopeCommand(body.sessionName, args), {
              env: cleanEnv,
              stdout: "pipe",
              stderr: "pipe",
              cwd: body.projectDir,
            });
            let el = 0;
            while (el < SESSION_READY_TIMEOUT_MS) {
              await new Promise((r) => setTimeout(r, SESSION_READY_POLL_MS));
              el += SESSION_READY_POLL_MS;
              const listProc = Bun.spawn(["zellij", "list-sessions", "--short"], {
                env: cleanEnv,
                stdout: "pipe",
                stderr: "pipe",
              });
              const listOutput = await new Response(listProc.stdout).text();
              await listProc.exited;
              if (listOutput.split("\n").some((l) => l.trim() === body.sessionName)) return true;
            }
            return false;
          }

          let sessionReady = await tryCreateZellijSession2(body.zellijLayout);
          if (!sessionReady && body.zellijLayout) {
            log.warn(`resume: layout "${body.zellijLayout}" failed, retrying without layout`);
            sessionReady = await tryCreateZellijSession2();
          }

          if (!sessionReady) {
            return Response.json(
              { error: `Zellij session "${body.sessionName}" did not start within ${SESSION_READY_TIMEOUT_MS}ms` },
              { status: 500 },
            );
          }

          // Send resume command
          const fullCmd = `${buildShellCommand(agentParts, body.projectDir)}\n`;
          Bun.spawn(["zellij", "--session", body.sessionName, "action", "write-chars", fullCmd], {
            env: cleanEnv,
            stdout: "pipe",
            stderr: "pipe",
          });

          if (agentType === "claude-code") {
            await new Promise((r) => setTimeout(r, TRUST_PROMPT_DELAY_MS));
            Bun.spawn(["zellij", "--session", body.sessionName, "action", "write-chars", "\n"], {
              env: cleanEnv,
              stdout: "pipe",
              stderr: "pipe",
            });

            if (body.autonomous) {
              await new Promise((r) => setTimeout(r, AUTONOMOUS_DISCLAIMER_DELAY_MS));
              Bun.spawn(["zellij", "--session", body.sessionName, "action", "write-chars", "\n"], {
                env: cleanEnv,
                stdout: "pipe",
                stderr: "pipe",
              });
            }
          }

          return Response.json({ ok: true });
        } catch (err) {
          log.error(`resume failed: ${err instanceof Error ? err.message : String(err)}`);
          const message = err instanceof Error ? err.message : String(err);
          return Response.json({ error: `Failed to resume session: ${message}` }, { status: 500 });
        }
      }

      // HTTP endpoint: reconnect agent in an existing multiplexer session
      //
      // Used when agent has exited but the mux session is still alive.
      // Sends resume command to the shell inside the mux session.
      if (url.pathname === "/api/reconnect" && req.method === "POST") {
        try {
          const body = (await req.json()) as {
            multiplexer: "zellij" | "tmux";
            session: string;
            sessionId: string;
            agentType?: AgentType;
            model?: string;
          };

          if (!body.session || !body.sessionId) {
            return Response.json({ error: "Missing session or sessionId" }, { status: 400 });
          }

          const agentType = body.agentType || "claude-code";
          const provider = getProvider(agentType);
          if (!provider) {
            return Response.json({ error: `Agent type "${agentType}" is not available` }, { status: 400 });
          }

          const sidErr = validateSessionId(body.sessionId);
          if (sidErr) return Response.json({ error: sidErr }, { status: 400 });

          if (body.model) {
            const modelErr = validateModel(body.model);
            if (modelErr) return Response.json({ error: modelErr }, { status: 400 });
          }

          const cleanEnv = cleanMultiplexerEnv();

          const agentParts = provider.buildResumeCommand({
            sessionId: body.sessionId,
            model: body.model,
          });
          const agentCmd = buildShellCommand(agentParts);

          if (body.multiplexer === "tmux") {
            const sendKeys = Bun.spawn(["tmux", "send-keys", "-t", body.session, agentCmd, "Enter"], {
              env: cleanEnv,
              stdout: "pipe",
              stderr: "pipe",
            });
            await sendKeys.exited;
            if (sendKeys.exitCode !== 0) {
              const stderr = await new Response(sendKeys.stderr).text();
              log.error(`tmux send-keys failed: ${stderr}`);
              return Response.json({ error: "Failed to send command to session" }, { status: 500 });
            }
          } else {
            const writeChars = Bun.spawn(
              ["zellij", "--session", body.session, "action", "write-chars", `${agentCmd}\n`],
              { env: cleanEnv, stdout: "pipe", stderr: "pipe" },
            );
            await writeChars.exited;
            if (writeChars.exitCode !== 0) {
              const stderr = await new Response(writeChars.stderr).text();
              log.error(`zellij write-chars failed: ${stderr}`);
              return Response.json({ error: "Failed to send command to session" }, { status: 500 });
            }
          }

          // Claude Code-specific: auto-accept workspace trust prompt
          if (agentType === "claude-code") {
            await new Promise((r) => setTimeout(r, TRUST_PROMPT_DELAY_MS));
            if (body.multiplexer === "tmux") {
              Bun.spawn(["tmux", "send-keys", "-t", body.session, "Enter"], {
                env: cleanEnv,
                stdout: "pipe",
                stderr: "pipe",
              });
            } else {
              Bun.spawn(["zellij", "--session", body.session, "action", "write-chars", "\n"], {
                env: cleanEnv,
                stdout: "pipe",
                stderr: "pipe",
              });
            }
          }

          log.info(`reconnect: session=${truncateId(body.sessionId)} agent=${agentType} mux=${body.session}`);
          return Response.json({ ok: true });
        } catch (err) {
          log.error(`reconnect failed: ${err instanceof Error ? err.message : String(err)}`);
          const message = err instanceof Error ? err.message : String(err);
          return Response.json({ error: `Failed to reconnect: ${message}` }, { status: 500 });
        }
      }

      // HTTP endpoint: kill/close a multiplexer session
      if (url.pathname === "/api/kill" && req.method === "POST") {
        try {
          const body = (await req.json()) as {
            multiplexer: "zellij" | "tmux";
            session: string;
          };

          if (!body.session) {
            return Response.json({ error: "Missing session" }, { status: 400 });
          }

          log.info(`kill: session=${body.session} mux=${body.multiplexer}`);
          const cleanEnv = cleanMultiplexerEnv();

          if (body.multiplexer === "tmux") {
            const proc = Bun.spawn(["tmux", "kill-session", "-t", body.session], {
              env: cleanEnv,
              stdout: "pipe",
              stderr: "pipe",
            });
            await proc.exited;
            if (proc.exitCode !== 0) {
              const stderr = await new Response(proc.stderr).text();
              log.error(`kill failed: tmux kill-session exit=${proc.exitCode} ${stderr}`);
              return Response.json({ error: "Failed to kill session" }, { status: 500 });
            }
          } else {
            // kill-session terminates running processes inside the session.
            // The session stays as EXITED — user can resurrect via
            // `zellij attach` or Resume from the dashboard.
            // delete-session is intentionally NOT called here.
            const kill = Bun.spawn(["zellij", "kill-session", body.session], {
              env: cleanEnv,
              stdout: "pipe",
              stderr: "pipe",
            });
            await kill.exited;
          }

          return Response.json({ ok: true });
        } catch (err) {
          log.error(`kill failed: ${err instanceof Error ? err.message : String(err)}`);
          return Response.json({ error: "Failed to kill session" }, { status: 500 });
        }
      }

      // HTTP endpoint: delete a session's data (JSONL, DB record, etc.)
      if (url.pathname === "/api/delete-session" && req.method === "POST") {
        try {
          const body = (await req.json()) as { sessionId: string; agentType?: AgentType };

          if (!body.sessionId) {
            return Response.json({ error: "Missing sessionId" }, { status: 400 });
          }

          const sidErr = validateSessionId(body.sessionId);
          if (sidErr) return Response.json({ error: sidErr }, { status: 400 });

          log.info(`delete-session: sessionId=${truncateId(body.sessionId)}`);

          // Try all providers if agentType not specified
          const agentType = body.agentType || "claude-code";
          const provider = getProvider(agentType);
          let deleted = false;

          if (provider) {
            deleted = await provider.deleteSessionData(body.sessionId);
          }

          if (!deleted) {
            // Try other providers as fallback
            for (const p of getAllProviders()) {
              if (p.type === agentType) continue;
              deleted = await p.deleteSessionData(body.sessionId);
              if (deleted) break;
            }
          }

          if (!deleted) {
            return Response.json({ error: "Session data not found" }, { status: 404 });
          }

          clearHookSession(body.sessionId);

          return Response.json({ ok: true });
        } catch (err) {
          log.error(`delete-session failed: ${err instanceof Error ? err.message : String(err)}`);
          const message = err instanceof Error ? err.message : String(err);
          return Response.json({ error: `Failed to delete session: ${message}` }, { status: 500 });
        }
      }

      // HTTP endpoint: send text to a multiplexer session
      //
      // Uses PTY attachment with bracketed paste mode for reliable text delivery
      // to both CLI prompts (Claude Code) and TUI apps (OpenCode Bubble Tea).
      // A backup Enter is sent via native multiplexer commands to ensure submission.
      if (url.pathname === "/api/send" && req.method === "POST") {
        try {
          const body = (await req.json()) as {
            multiplexer: "zellij" | "tmux";
            session: string;
            text: string;
            agentType?: AgentType;
          };

          if (!body.session || !body.text) {
            return Response.json({ error: "Missing session or text" }, { status: 400 });
          }

          const cleanEnv = cleanMultiplexerEnv();
          cleanEnv.TERM = "xterm-256color";

          log.info(
            `send: session=${body.session} mux=${body.multiplexer} agent=${body.agentType || "claude-code"} chars=${body.text.length}`,
          );

          const attachCmd = buildAttachCommand(body.multiplexer, body.session);
          await sendViaPTY(attachCmd, body.text, body.agentType, cleanEnv);

          // Backup Enter via native command in case PTY CR was swallowed
          await sendBackupEnter(body.multiplexer, body.session, cleanEnv);

          log.debug("send: completed");
          return Response.json({ ok: true });
        } catch (err) {
          log.error(`send failed: ${err instanceof Error ? err.message : "unknown"}`);
          const message = err instanceof Error ? err.message : "Failed to send";
          return Response.json({ error: message }, { status: 500 });
        }
      }

      // HTTP endpoint: rename a multiplexer session
      if (url.pathname === "/api/rename-session" && req.method === "POST") {
        try {
          const body = (await req.json()) as {
            multiplexer: "zellij" | "tmux";
            currentName: string;
            newName: string;
          };

          if (!body.currentName || !body.newName) {
            return Response.json({ error: "Missing currentName or newName" }, { status: 400 });
          }

          const cleanEnv = cleanMultiplexerEnv();

          if (body.multiplexer === "tmux") {
            const proc = Bun.spawn(["tmux", "rename-session", "-t", body.currentName, body.newName], {
              env: cleanEnv,
              stdout: "pipe",
              stderr: "pipe",
            });
            await proc.exited;
            if (proc.exitCode !== 0) {
              const stderr = await new Response(proc.stderr).text();
              log.error(`tmux rename failed: ${stderr}`);
              return Response.json({ error: "Failed to rename session" }, { status: 500 });
            }
          } else {
            // zellij: rename-session action requires targeting the session
            const proc = Bun.spawn(
              ["zellij", "--session", body.currentName, "action", "rename-session", body.newName],
              { env: cleanEnv, stdout: "pipe", stderr: "pipe" },
            );
            await proc.exited;
            if (proc.exitCode !== 0) {
              const stderr = await new Response(proc.stderr).text();
              log.error(`zellij rename failed: ${stderr}`);
              return Response.json({ error: "Failed to rename session" }, { status: 500 });
            }
          }

          // Store the rename mapping so the process mapper can resolve
          // stale ZELLIJ_SESSION_NAME env vars. Persisted to disk so it
          // survives agent restarts.
          sessionRenameMap.set(body.currentName, body.newName);
          saveRenameMap();
          log.info(`rename: ${body.currentName} → ${body.newName}`);

          return Response.json({ ok: true });
        } catch (err) {
          log.error(`rename failed: ${err instanceof Error ? err.message : String(err)}`);
          return Response.json({ error: "Failed to rename session" }, { status: 500 });
        }
      }

      // HTTP endpoint: receive hook/event data from any agent
      // Responds immediately so we don't slow down the agent.
      if (url.pathname === "/api/hook-event" && req.method === "POST") {
        try {
          const body = await req.json();
          // Try each provider's hook handler until one recognizes the payload
          for (const provider of getAllProviders()) {
            const result = provider.handleHookEvent(body);
            if (result) {
              updateHookState(result);
              log.debug(
                `hook: agent=${provider.type} session=${truncateId(result.sessionId)} status=${result.status}${result.currentTool ? ` tool=${result.currentTool}` : ""}`,
              );
              break;
            }
          }
        } catch (err) {
          log.debug(`hook-event: failed to process: ${err instanceof Error ? err.message : String(err)}`);
        }
        return Response.json({ exit: 0 });
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
          log.warn("ws: terminal connection without session name");
          ws.send(JSON.stringify({ type: "error", message: "No session specified" }));
          ws.close();
          return;
        }

        log.info(`ws: terminal attached session=${session} mux=${multiplexer} ${cols}x${rows}`);
        const cmd = buildAttachCommand(multiplexer, session);

        const cleanEnv = cleanTerminalEnv();

        const proc = Bun.spawn(["python3", PTY_HELPER, String(cols), String(rows), ...cmd], {
          stdin: "pipe",
          stdout: "pipe",
          stderr: "pipe",
          env: cleanEnv,
        });

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
              } catch (err) {
                log.debug(
                  `terminal:${session} ws send failed, stopping reader: ${err instanceof Error ? err.message : String(err)}`,
                );
                break;
              }
            }
          } catch (err) {
            log.debug(`terminal:${session} stdout reader ended: ${err instanceof Error ? err.message : String(err)}`);
          }
          try {
            ws.close();
          } catch (err) {
            log.debug(`terminal:${session} ws already closed: ${err instanceof Error ? err.message : String(err)}`);
          }
        })();

        // Read stderr for debugging
        (async () => {
          const reader = proc.stderr.getReader();
          try {
            while (true) {
              const { done, value } = await reader.read();
              if (done) break;
              log.debug(`terminal:${session} stderr: ${new TextDecoder().decode(value).trim()}`);
            }
          } catch (err) {
            log.debug(`terminal:${session} stderr reader ended: ${err instanceof Error ? err.message : String(err)}`);
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
                `${JSON.stringify({ type: "resize", cols: parsed.cols, rows: parsed.rows })}\n`,
              );
              return;
            }
          } catch (_err) {
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
          log.info(`ws: terminal disconnected session=${terminal.identifier}`);
          terminal.process.kill();
          activeTerminals.delete(ws);
        }
      },
    },
  });

  log.info(`listening on ws://0.0.0.0:${port}/ws/terminal`);
  return server;
}
