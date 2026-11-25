import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  type AgentType,
  buildShellCommand,
  createLogger,
  errorMessage,
  type PermissionMode,
  resolvePermissionMode,
  type TerminalMultiplexer,
  truncateId,
} from "@agent-town/shared";
import { resolveDataDir } from "@agent-town/shared/data-dir";
import type { Server } from "bun";

import { guardAgentRequest } from "./agent-guard";
import { fetchGitDiff, GitDiffError, validateDiffDir } from "./git-diff";
import { listDirectories, validateListDirsPath } from "./list-dirs";
import {
  buildAttachCommand,
  cleanMultiplexerEnv,
  createMuxSession,
  killMuxSession,
  type MuxEnv,
  renameMuxSession,
  typeLine,
} from "./mux-control";
import { getAllProviders, getProvider } from "./providers/registry";
import type { AgentProvider } from "./providers/types";
import { type PtyProcess, spawnPty } from "./pty";
import { getSessionMessages, searchSessionMessages } from "./session-messages";
import { cleanupRecoveryBySessionId, writeWrapperScript } from "./session-recovery";

const log = createLogger("terminal");

// --- Timing constants ---
const TRUST_PROMPT_DELAY_MS = 3000;
const AUTONOMOUS_DISCLAIMER_DELAY_MS = 2000;
const INITIAL_MESSAGE_DELAY_MS = 3000;
const PTY_INIT_DELAY_MS = 1000;
const PTY_INPUT_BASE_DELAY_MS = 500;
const BRACKETED_PASTE_DELAY_MS = 100;
const SEND_PTY_COLS = 120;
const SEND_PTY_ROWS = 40;
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
  // UUIDs, OpenCode ses_* IDs, and Pi custom IDs (which may contain dots).
  if (!/^[a-zA-Z0-9._-]+$/i.test(id)) return "Session ID contains invalid characters";
  return null;
}

// --- Environment helpers ---

function cleanTerminalEnv(): MuxEnv {
  const env = cleanMultiplexerEnv();
  env.TERM = "xterm-256color";
  env.COLORTERM = "truecolor";
  env.LANG = env.LANG || "en_US.UTF-8";
  return env;
}

interface TerminalSession {
  process: PtyProcess;
  machineId: string;
  identifier: string;
}

const activeTerminals = new Map<unknown, TerminalSession>();

// Tracks multiplexer session renames: oldName → newName.
// When a session is renamed via the dashboard, the ZELLIJ_SESSION_NAME
// env var in the shell process stays stale. This map lets the process
// mapper resolve the stale name to the current name.
// Persisted to disk so it survives agent restarts.
const RENAME_MAP_DIR = resolveDataDir();
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
    log.debug(`rename map not loaded: ${errorMessage(err)}`);
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
    log.warn(`failed to save rename map: ${errorMessage(err)}`);
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
    resolved = sessionRenameMap.get(resolved) ?? resolved;
  }
  return resolved;
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
  inputMode: AgentProvider["terminal"]["inputMode"],
  cleanEnv: Record<string, string | undefined>,
): Promise<void> {
  const proc = spawnPty(attachCmd, { cols: SEND_PTY_COLS, rows: SEND_PTY_ROWS, env: cleanEnv });

  await new Promise((r) => setTimeout(r, PTY_INIT_DELAY_MS));

  if (inputMode === "bracketed-paste") {
    // Bracketed paste for TUI apps (OpenCode Bubble Tea, Gemini CLI) —
    // handles the entire paste as one event instead of individual keystrokes.
    // \x1b[200~ = paste start, \x1b[201~ = paste end
    proc.write(`\x1b[200~${text}\x1b[201~`);
    await new Promise((r) => setTimeout(r, BRACKETED_PASTE_DELAY_MS));
    proc.write("\r");
  } else {
    // Claude Code: write text then Enter separately so the TUI
    // processes them as distinct events (not a single paste).
    proc.write(text);
    await new Promise((r) => setTimeout(r, BRACKETED_PASTE_DELAY_MS));
    proc.write("\r");
  }

  await new Promise((r) => setTimeout(r, PTY_INPUT_BASE_DELAY_MS));
  proc.kill();
}

/**
 * Send a backup Enter keystroke via native multiplexer command
 * in case the PTY carriage return was swallowed.
 */
async function sendBackupEnter(multiplexer: TerminalMultiplexer, session: string, env: MuxEnv): Promise<void> {
  await Bun.sleep(BACKUP_ENTER_DELAY_MS);
  if (!(await typeLine(multiplexer, session, "", env))) log.debug(`sendBackupEnter: ${multiplexer} failed`);
}

// --- Launch helpers ---

interface StartAgentOptions {
  multiplexer: TerminalMultiplexer;
  session: string;
  command: string;
  provider: AgentProvider;
  permissionMode?: PermissionMode;
  autonomous?: boolean;
  /** Send "hi" so CLI agents write their session file right away (new sessions only). */
  sendInitialMessage: boolean;
  env: MuxEnv;
}

/**
 * Type the agent command into a session's shell, then get CLI agents past
 * their startup prompts: accept workspace trust, the autonomous-mode
 * disclaimer, and optionally send a first message. TUI agents need none of it.
 */
export function requiresYoloDisclaimer(provider: AgentProvider, mode?: PermissionMode): boolean {
  return mode === "yolo" && provider.terminal.autonomousDisclaimer;
}

async function startAgentInSession(opts: StartAgentOptions): Promise<void> {
  if (!(await typeLine(opts.multiplexer, opts.session, opts.command, opts.env))) {
    throw new Error("Failed to send command to session");
  }
  if (opts.provider.terminal.startupMode !== "cli-prompt") return;

  await Bun.sleep(TRUST_PROMPT_DELAY_MS);
  await typeLine(opts.multiplexer, opts.session, "", opts.env);
  if (requiresYoloDisclaimer(opts.provider, opts.permissionMode)) {
    await Bun.sleep(AUTONOMOUS_DISCLAIMER_DELAY_MS);
    await typeLine(opts.multiplexer, opts.session, "", opts.env);
  }
  if (opts.sendInitialMessage) {
    await Bun.sleep(INITIAL_MESSAGE_DELAY_MS);
    await typeLine(opts.multiplexer, opts.session, "hi", opts.env);
  }
}

interface NewSessionRequest {
  sessionName: string;
  projectDir: string;
  multiplexer: TerminalMultiplexer;
  agentType?: AgentType;
  zellijLayout?: string;
  model?: string;
  permissionMode?: PermissionMode;
  autonomous?: boolean;
}

/** Validate the fields shared by launch and resume; returns an error message or null. */
function validateNewSessionRequest(body: NewSessionRequest): string | null {
  return (
    validateSessionName(body.sessionName) ??
    validateProjectDir(body.projectDir) ??
    (body.model ? validateModel(body.model) : null)
  );
}

export interface TerminalServerOptions {
  /** Interface to bind (see resolveAgentBindHost). */
  hostname: string;
  /** Shared secret the server must present. */
  token: string;
  /** Browser origins allowed to call the agent (normally none). */
  allowedOrigins: readonly string[];
}

export function startTerminalServer(port: number, machineId: string, opts: TerminalServerOptions): Server {
  const guardOptions = { token: opts.token, allowedOrigins: opts.allowedOrigins };

  const server = Bun.serve({
    port,
    hostname: opts.hostname,

    async fetch(req, server) {
      const denied = guardAgentRequest(req, guardOptions);
      if (denied) return denied;

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

      // HTTP endpoint: search across session message content
      if (url.pathname === "/api/search-messages" && req.method === "GET") {
        const query = url.searchParams.get("query");
        const limitParam = url.searchParams.get("limit") || "50";
        const limit = parseInt(limitParam, 10);

        if (!query || query.length < 3) {
          return Response.json({ error: "Query must be at least 3 characters" }, { status: 400 });
        }

        if (Number.isNaN(limit) || limit < 1 || limit > 200) {
          return Response.json({ error: "Limit must be between 1 and 200" }, { status: 400 });
        }

        try {
          const results = await searchSessionMessages(query, limit);
          return Response.json({ results });
        } catch (err) {
          const message = err instanceof Error ? err.message : "Unknown error";
          log.error(`search-messages: failed: ${message}`);
          return Response.json({ error: message }, { status: 500 });
        }
      }

      // HTTP endpoint: get git diff for a directory
      if (url.pathname === "/api/git-diff" && req.method === "GET") {
        const dir = url.searchParams.get("dir");

        const dirErr = validateDiffDir(dir || "");
        if (dirErr) {
          return Response.json({ error: dirErr }, { status: 400 });
        }

        try {
          const result = await fetchGitDiff(dir ?? "");
          return Response.json(result);
        } catch (err) {
          if (err instanceof GitDiffError) {
            return Response.json({ error: err.message }, { status: err.statusCode });
          }
          const message = err instanceof Error ? err.message : "Unknown error";
          log.error(`git-diff: failed for dir=${dir}: ${message}`);
          return Response.json({ error: message }, { status: 500 });
        }
      }

      // HTTP endpoint: list directories in a path
      if (url.pathname === "/api/list-dirs" && req.method === "GET") {
        const dir = url.searchParams.get("dir");

        const dirErr = validateListDirsPath(dir || "");
        if (dirErr) {
          return Response.json({ error: dirErr }, { status: 400 });
        }

        try {
          const result = await listDirectories(dir ?? "");
          return Response.json(result);
        } catch (err) {
          const message = err instanceof Error ? err.message : "Unknown error";
          const isNotFound = message.includes("ENOENT") || message.includes("no such file");
          const isPermission = message.includes("EACCES") || message.includes("permission denied");
          if (isNotFound) {
            return Response.json({ error: `Directory not found: ${dir}` }, { status: 404 });
          }
          if (isPermission) {
            return Response.json({ error: `Permission denied: ${dir}` }, { status: 403 });
          }
          log.error(`list-dirs: failed for dir=${dir}: ${message}`);
          return Response.json({ error: message }, { status: 500 });
        }
      }

      // HTTP endpoint: launch a new multiplexer session with an agent
      if (url.pathname === "/api/launch" && req.method === "POST") {
        try {
          const body = (await req.json()) as NewSessionRequest;
          const agentType = body.agentType || "claude-code";
          let permissionMode: PermissionMode;
          try {
            permissionMode = resolvePermissionMode(body, agentType);
          } catch (err) {
            return Response.json({ error: errorMessage(err) }, { status: 400 });
          }
          const provider = getProvider(agentType);
          if (!provider) {
            return Response.json({ error: `Agent type "${agentType}" is not available` }, { status: 400 });
          }

          log.info(
            `launch: name=${body.sessionName} agent=${agentType} mux=${body.multiplexer} dir=${body.projectDir} model=${body.model || "default"} permissionMode=${permissionMode}`,
          );
          const validationError = validateNewSessionRequest(body);
          if (validationError) return Response.json({ error: validationError }, { status: 400 });

          // Claude Code runs through a wrapper script so that multiplexer session
          // recovery after a reboot resumes the session instead of starting fresh.
          const command =
            agentType === "claude-code"
              ? await writeWrapperScript(body.sessionName, {
                  muxSessionName: body.sessionName,
                  projectDir: body.projectDir,
                  model: body.model,
                  permissionMode,
                })
              : buildShellCommand(provider.buildLaunchCommand({ model: body.model, permissionMode }), body.projectDir);

          const env = cleanMultiplexerEnv();
          await createMuxSession(body.multiplexer, body.sessionName, body.projectDir, env, body.zellijLayout);
          await startAgentInSession({
            multiplexer: body.multiplexer,
            session: body.sessionName,
            command,
            provider,
            permissionMode,
            sendInitialMessage: true,
            env,
          });
          return Response.json({ ok: true });
        } catch (err) {
          log.error(`launch failed: ${errorMessage(err)}`);
          return Response.json({ error: `Failed to launch session: ${errorMessage(err)}` }, { status: 500 });
        }
      }

      // HTTP endpoint: resume an existing session in a new multiplexer session
      if (url.pathname === "/api/resume" && req.method === "POST") {
        try {
          const body = (await req.json()) as NewSessionRequest & { sessionId: string };
          const agentType = body.agentType || "claude-code";
          let permissionMode: PermissionMode;
          try {
            permissionMode = resolvePermissionMode(body, agentType);
          } catch (err) {
            return Response.json({ error: errorMessage(err) }, { status: 400 });
          }
          const provider = getProvider(agentType);
          if (!provider) {
            return Response.json({ error: `Agent type "${agentType}" is not available` }, { status: 400 });
          }

          log.info(
            `resume: session=${truncateId(body.sessionId)} agent=${agentType} name=${body.sessionName} mux=${body.multiplexer} dir=${body.projectDir}`,
          );
          const validationError = validateSessionId(body.sessionId) ?? validateNewSessionRequest(body);
          if (validationError) return Response.json({ error: validationError }, { status: 400 });

          const command = buildShellCommand(
            provider.buildResumeCommand({ sessionId: body.sessionId, model: body.model, permissionMode }),
            body.projectDir,
          );
          const env = cleanMultiplexerEnv();
          await createMuxSession(body.multiplexer, body.sessionName, body.projectDir, env, body.zellijLayout);
          await startAgentInSession({
            multiplexer: body.multiplexer,
            session: body.sessionName,
            command,
            provider,
            permissionMode,
            sendInitialMessage: false,
            env,
          });
          return Response.json({ ok: true });
        } catch (err) {
          log.error(`resume failed: ${errorMessage(err)}`);
          return Response.json({ error: `Failed to resume session: ${errorMessage(err)}` }, { status: 500 });
        }
      }

      // HTTP endpoint: reconnect agent in an existing multiplexer session
      //
      // Used when agent has exited but the mux session is still alive.
      // Sends resume command to the shell inside the mux session.
      if (url.pathname === "/api/reconnect" && req.method === "POST") {
        try {
          const body = (await req.json()) as {
            multiplexer: TerminalMultiplexer;
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

          const validationError = validateSessionId(body.sessionId) ?? (body.model ? validateModel(body.model) : null);
          if (validationError) return Response.json({ error: validationError }, { status: 400 });

          await startAgentInSession({
            multiplexer: body.multiplexer,
            session: body.session,
            command: buildShellCommand(provider.buildResumeCommand({ sessionId: body.sessionId, model: body.model })),
            provider,
            sendInitialMessage: false,
            env: cleanMultiplexerEnv(),
          });

          log.info(`reconnect: session=${truncateId(body.sessionId)} agent=${agentType} mux=${body.session}`);
          return Response.json({ ok: true });
        } catch (err) {
          log.error(`reconnect failed: ${errorMessage(err)}`);
          return Response.json({ error: `Failed to reconnect: ${errorMessage(err)}` }, { status: 500 });
        }
      }

      // HTTP endpoint: kill/close a multiplexer session
      if (url.pathname === "/api/kill" && req.method === "POST") {
        try {
          const body = (await req.json()) as {
            multiplexer: TerminalMultiplexer;
            session: string;
          };

          if (!body.session) {
            return Response.json({ error: "Missing session" }, { status: 400 });
          }

          log.info(`kill: session=${body.session} mux=${body.multiplexer}`);
          if (!(await killMuxSession(body.multiplexer, body.session, cleanMultiplexerEnv()))) {
            log.error(`kill failed: ${body.multiplexer} session=${body.session}`);
            return Response.json({ error: "Failed to kill session" }, { status: 500 });
          }

          return Response.json({ ok: true });
        } catch (err) {
          log.error(`kill failed: ${errorMessage(err)}`);
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

          // Preserve the legacy cross-provider lookup only when the caller omitted a type.
          const hasExplicitAgentType = body.agentType !== undefined;
          const agentType = body.agentType || "claude-code";
          const provider = getProvider(agentType);
          let deleted = false;

          if (provider) {
            deleted = await provider.deleteSessionData(body.sessionId);
          }

          if (!deleted && !hasExplicitAgentType) {
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

          // Clean up session recovery wrapper script and metadata
          cleanupRecoveryBySessionId(body.sessionId);

          return Response.json({ ok: true });
        } catch (err) {
          log.error(`delete-session failed: ${errorMessage(err)}`);
          const message = errorMessage(err);
          return Response.json({ error: `Failed to delete session: ${message}` }, { status: 500 });
        }
      }

      // HTTP endpoint: upload a file to the agent machine
      if (url.pathname === "/api/upload" && req.method === "POST") {
        try {
          const { mkdirSync, writeFileSync } = await import("node:fs");
          const { join } = await import("node:path");
          const { UPLOAD_DIR, MAX_UPLOAD_SIZE_BYTES, sanitizeFilename } = await import("./file-upload");

          const formData = await req.formData();
          const file = formData.get("file");

          if (!file || !(file instanceof File)) {
            return Response.json({ error: "No file provided" }, { status: 400 });
          }

          if (file.size > MAX_UPLOAD_SIZE_BYTES) {
            return Response.json(
              {
                error: `File too large (${Math.round(file.size / 1024 / 1024)}MB). Max: ${Math.round(MAX_UPLOAD_SIZE_BYTES / 1024 / 1024)}MB`,
              },
              { status: 413 },
            );
          }

          mkdirSync(UPLOAD_DIR, { recursive: true });

          const safeName = sanitizeFilename(file.name);
          const filePath = join(UPLOAD_DIR, safeName);

          const buffer = await file.arrayBuffer();
          writeFileSync(filePath, Buffer.from(buffer));

          log.info(`upload: saved ${file.name} (${file.size} bytes) as ${safeName}`);

          return Response.json({
            ok: true,
            path: filePath,
            filename: file.name,
          });
        } catch (err) {
          log.error(`upload failed: ${err instanceof Error ? err.message : "unknown"}`);
          return Response.json({ error: "Upload failed" }, { status: 500 });
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
            multiplexer: TerminalMultiplexer;
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
          const inputMode = getProvider(body.agentType || "claude-code")?.terminal.inputMode ?? "direct";
          await sendViaPTY(attachCmd, body.text, inputMode, cleanEnv);

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
            multiplexer: TerminalMultiplexer;
            currentName: string;
            newName: string;
          };

          if (!body.currentName || !body.newName) {
            return Response.json({ error: "Missing currentName or newName" }, { status: 400 });
          }

          if (!(await renameMuxSession(body.multiplexer, body.currentName, body.newName, cleanMultiplexerEnv()))) {
            log.error(`rename failed: ${body.multiplexer} ${body.currentName} → ${body.newName}`);
            return Response.json({ error: "Failed to rename session" }, { status: 500 });
          }

          // Store the rename mapping so the process mapper can resolve
          // stale ZELLIJ_SESSION_NAME env vars. Persisted to disk so it
          // survives agent restarts.
          sessionRenameMap.set(body.currentName, body.newName);
          saveRenameMap();
          log.info(`rename: ${body.currentName} → ${body.newName}`);

          return Response.json({ ok: true });
        } catch (err) {
          log.error(`rename failed: ${errorMessage(err)}`);
          return Response.json({ error: "Failed to rename session" }, { status: 500 });
        }
      }

      return new Response("Agent Town Terminal Server", { status: 200 });
    },

    websocket: {
      open(ws) {
        const { multiplexer, session, cols, rows } = ws.data as {
          multiplexer: TerminalMultiplexer;
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

        const proc = spawnPty(cmd, {
          cols,
          rows,
          env: cleanEnv,
          onData: (data) => {
            try {
              ws.send(data);
            } catch (err) {
              log.debug(`terminal:${session} ws send failed: ${errorMessage(err)}`);
            }
          },
        });

        activeTerminals.set(ws, { process: proc, machineId, identifier: session });

        proc.exited.then(() => {
          try {
            ws.close();
          } catch (err) {
            log.debug(`terminal:${session} ws already closed: ${errorMessage(err)}`);
          }
        });
      },

      message(ws, message) {
        const terminal = activeTerminals.get(ws);
        if (!terminal) return;

        if (typeof message === "string") {
          try {
            const parsed = JSON.parse(message);
            if (parsed.type === "resize") {
              const cols = Number(parsed.cols);
              const rows = Number(parsed.rows);
              if (Number.isInteger(cols) && Number.isInteger(rows) && cols > 0 && rows > 0) {
                terminal.process.resize(cols, rows);
              }
              return;
            }
          } catch (_err) {
            // Not JSON, treat as terminal input
          }
          terminal.process.write(message);
        } else {
          terminal.process.write(message as Uint8Array);
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

  log.info(`listening on http://${opts.hostname}:${port}`);
  return server;
}
