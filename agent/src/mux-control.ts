import { createLogger, errorMessage, type TerminalMultiplexer } from "@agent-town/shared";

/**
 * Every tmux/zellij command the agent runs to control sessions, behind one
 * small interface so request handlers don't branch on the multiplexer.
 */
const log = createLogger("mux");

const SESSION_READY_POLL_MS = 300;
export const SESSION_READY_TIMEOUT_MS = 5000;

export type MuxEnv = Record<string, string | undefined>;

/** The agent's environment minus anything that would nest it inside its own multiplexer. */
export function cleanMultiplexerEnv(): MuxEnv {
  const env = { ...process.env };
  delete env.ZELLIJ;
  delete env.ZELLIJ_SESSION_NAME;
  delete env.ZELLIJ_PANE_ID;
  delete env.TMUX;
  delete env.TMUX_PANE;
  delete env.CLAUDECODE;
  return env;
}

export function buildAttachCommand(multiplexer: TerminalMultiplexer, session: string): string[] {
  return multiplexer === "zellij" ? ["zellij", "attach", session] : ["tmux", "attach-session", "-t", session];
}

interface RunResult {
  ok: boolean;
  stdout: string;
  stderr: string;
}

async function run(cmd: string[], env?: MuxEnv, cwd?: string): Promise<RunResult> {
  const proc = Bun.spawn(cmd, { env, cwd, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr] = await Promise.all([
    Bun.readableStreamToText(proc.stdout),
    Bun.readableStreamToText(proc.stderr),
  ]);
  await proc.exited;
  if (proc.exitCode !== 0) log.debug(`${cmd[0]} ${cmd[1] ?? ""} failed: exit=${proc.exitCode} ${stderr.trim()}`);
  return { ok: proc.exitCode === 0, stdout, stderr };
}

// --- Cgroup isolation ---
//
// Launched multiplexer sessions must NOT be children of the agent-town
// systemd service. If they are, `systemctl restart agent-town` kills
// every zellij/tmux session (and the agents running inside them).
// systemd-run --user --scope gives each session its own cgroup scope.

let systemdRunAvailable: boolean | null = null;

async function checkSystemdRun(): Promise<boolean> {
  if (systemdRunAvailable !== null) return systemdRunAvailable;
  try {
    // Test actual scope creation: --version succeeds even without a user
    // session (e.g. an agent started via SSH nohup).
    systemdRunAvailable = (await run(["systemd-run", "--user", "--scope", "--unit=agent-town-test-scope", "true"])).ok;
  } catch (err) {
    log.debug(`systemd-run check failed: ${errorMessage(err)}`);
    systemdRunAvailable = false;
  }
  log.info(
    `cgroup isolation: systemd-run --scope ${systemdRunAvailable ? "works" : "not available, using direct spawn"}`,
  );
  return systemdRunAvailable;
}

// Check on module load (non-blocking)
checkSystemdRun();

function buildScopeCommand(session: string, cmd: string[]): string[] {
  if (!systemdRunAvailable) return cmd;
  // A timestamp suffix avoids clashing with lingering units from a previous session of the same name.
  return ["systemd-run", "--user", "--scope", `--unit=agent-town-mux-${session}-${Date.now().toString(36)}`, ...cmd];
}

/**
 * Before creating a zellij session: delete an EXITED session with the same
 * name (zellij keeps those and refuses to reuse the name) and stop lingering
 * scope units from a previous session of that name.
 */
async function cleanupBeforeZellijCreate(session: string, env: MuxEnv): Promise<void> {
  await run(["zellij", "delete-session", session, "--force"], env);
  if (!systemdRunAvailable) return;
  const { stdout } = await run(["systemctl", "--user", "list-units", "--type=scope", "--plain", "--no-legend"]);
  for (const line of stdout.split("\n")) {
    const unit = line.trim().split(/\s+/)[0];
    if (unit?.startsWith(`agent-town-mux-${session}`)) {
      await run(["systemctl", "--user", "stop", unit]);
      log.debug(`cleanup: stopped lingering scope ${unit}`);
    }
  }
}

async function zellijSessionExists(session: string, env: MuxEnv): Promise<boolean> {
  const { stdout } = await run(["zellij", "list-sessions", "--short"], env);
  return stdout.split("\n").some((line) => line.trim() === session);
}

async function startZellijSession(session: string, projectDir: string, env: MuxEnv, layout?: string): Promise<boolean> {
  const args = ["zellij", "-s", session];
  if (layout) args.push("-n", layout);
  // zellij -s panics with ENOTTY without a TTY but still creates the session,
  // so don't wait for it: poll until the session shows up instead.
  Bun.spawn(buildScopeCommand(session, args), { env, cwd: projectDir, stdout: "ignore", stderr: "ignore" });
  for (let waited = 0; waited < SESSION_READY_TIMEOUT_MS; waited += SESSION_READY_POLL_MS) {
    await Bun.sleep(SESSION_READY_POLL_MS);
    if (await zellijSessionExists(session, env)) return true;
  }
  return false;
}

/** Create a detached session in `projectDir`. Throws with a user-facing message on failure. */
export async function createMuxSession(
  multiplexer: TerminalMultiplexer,
  session: string,
  projectDir: string,
  env: MuxEnv,
  zellijLayout?: string,
): Promise<void> {
  if (multiplexer === "tmux") {
    const result = await run(
      buildScopeCommand(session, ["tmux", "new-session", "-d", "-s", session, "-c", projectDir]),
      env,
    );
    if (!result.ok) {
      log.error(`tmux new-session failed: ${result.stderr.trim()}`);
      throw new Error("Failed to create multiplexer session");
    }
    return;
  }

  await cleanupBeforeZellijCreate(session, env);
  // The layout may not exist on remote machines: retry without it.
  let ready = await startZellijSession(session, projectDir, env, zellijLayout);
  if (!ready && zellijLayout) {
    log.warn(`zellij layout "${zellijLayout}" failed, retrying without layout`);
    ready = await startZellijSession(session, projectDir, env);
  }
  if (!ready) throw new Error(`Zellij session "${session}" did not start within ${SESSION_READY_TIMEOUT_MS}ms`);
}

/** Type `text` into the session's active pane and press Enter (just Enter when text is empty). */
export async function typeLine(
  multiplexer: TerminalMultiplexer,
  session: string,
  text: string,
  env: MuxEnv,
): Promise<boolean> {
  if (multiplexer === "zellij") {
    return (await run(["zellij", "--session", session, "action", "write-chars", `${text}\n`], env)).ok;
  }
  // -l sends the text literally, so words like "Enter" or "C-c" aren't read as key names.
  if (text && !(await run(["tmux", "send-keys", "-t", session, "-l", text], env)).ok) return false;
  return (await run(["tmux", "send-keys", "-t", session, "Enter"], env)).ok;
}

export async function killMuxSession(multiplexer: TerminalMultiplexer, session: string, env: MuxEnv): Promise<boolean> {
  if (multiplexer === "tmux") return (await run(["tmux", "kill-session", "-t", session], env)).ok;
  // delete-session --force kills the running processes and removes the session;
  // the agent session can still be resumed into a new zellij session.
  await run(["zellij", "delete-session", session, "--force"], env);
  return true;
}

export async function renameMuxSession(
  multiplexer: TerminalMultiplexer,
  current: string,
  next: string,
  env: MuxEnv,
): Promise<boolean> {
  const cmd =
    multiplexer === "tmux"
      ? ["tmux", "rename-session", "-t", current, next]
      : ["zellij", "--session", current, "action", "rename-session", next];
  return (await run(cmd, env)).ok;
}
