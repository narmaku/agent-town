import { createLogger, errorMessage, type MultiplexerSessionInfo, type TerminalMultiplexer } from "@agent-town/shared";

const log = createLogger("multiplexer");

async function runCommand(cmd: string[]): Promise<string> {
  const proc = Bun.spawn(cmd, {
    stdout: "pipe",
    stderr: "ignore",
  });
  const output = await Bun.readableStreamToText(proc.stdout);
  await proc.exited;
  return output.trim();
}

async function isAvailable(binary: string): Promise<boolean> {
  try {
    const proc = Bun.spawn(["which", binary], { stdout: "ignore", stderr: "ignore" });
    await proc.exited;
    return proc.exitCode === 0;
  } catch (err) {
    log.debug(`which ${binary} failed: ${errorMessage(err)}`);
    return false;
  }
}

// Cache detectMultiplexers result — available multiplexers don't change at runtime
let cachedMultiplexers: TerminalMultiplexer[] | null = null;

export async function detectMultiplexers(): Promise<TerminalMultiplexer[]> {
  if (cachedMultiplexers) return cachedMultiplexers;
  const result: TerminalMultiplexer[] = [];
  if (await isAvailable("zellij")) result.push("zellij");
  if (await isAvailable("tmux")) result.push("tmux");
  cachedMultiplexers = result;
  return result;
}

export async function listZellijSessions(): Promise<MultiplexerSessionInfo[]> {
  try {
    const output = await runCommand(["zellij", "list-sessions", "--short"]);
    if (!output) return [];
    const sessions = output
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        // zellij --short outputs session names, one per line
        // Active sessions don't have "(EXITED)" suffix
        const exited = line.includes("EXITED");
        const name = line.replace(/\s*\(EXITED.*\)/, "").trim();
        return {
          name,
          multiplexer: "zellij" as const,
          attached: !exited,
        };
      });
    log.debug(`zellij: found ${sessions.length} session(s)`);
    return sessions;
  } catch (err) {
    log.debug(`zellij list-sessions failed: ${errorMessage(err)}`);
    return [];
  }
}

export async function listTmuxSessions(): Promise<MultiplexerSessionInfo[]> {
  try {
    const output = await runCommand(["tmux", "list-sessions", "-F", "#{session_name}:#{session_attached}"]);
    const sessions = parseTmuxSessions(output);
    log.debug(`tmux: found ${sessions.length} session(s)`);
    return sessions;
  } catch (err) {
    log.debug(`tmux list-sessions failed: ${errorMessage(err)}`);
    return [];
  }
}

export function parseTmuxSessions(output: string): MultiplexerSessionInfo[] {
  return output
    .split("\n")
    .filter(Boolean)
    .map((line) => ({
      name: line.split(":")[0],
      multiplexer: "tmux" as const,
      // Unlike zellij's retained EXITED sessions, every listed tmux session
      // exists. session_attached counts viewers, not running agent processes.
      attached: true,
    }));
}

export interface TmuxPaneInfo {
  pid: number;
  cwd: string;
  session: string;
  tty: string;
}

export function parseTmuxPanes(output: string): TmuxPaneInfo[] {
  return output.split("\n").flatMap((line) => {
    const [pid, cwd, session, tty] = line.split("\t");
    const processId = Number(pid);
    if (!Number.isSafeInteger(processId) || processId <= 0 || !cwd || !session || !tty) return [];
    return [{ pid: processId, cwd, session, tty }];
  });
}

/** Pane roots and cwd come from the tmux server, even if /proc reads are denied. */
export async function listTmuxPanes(): Promise<TmuxPaneInfo[]> {
  try {
    const output = await runCommand([
      "tmux",
      "list-panes",
      "-a",
      "-F",
      "#{pane_pid}\t#{pane_current_path}\t#{session_name}\t#{pane_tty}",
    ]);
    return parseTmuxPanes(output);
  } catch (err) {
    log.debug(`tmux list-panes failed: ${errorMessage(err)}`);
    return [];
  }
}

export async function listAllSessions(): Promise<MultiplexerSessionInfo[]> {
  const [zellijSessions, tmuxSessions] = await Promise.all([listZellijSessions(), listTmuxSessions()]);
  return [...zellijSessions, ...tmuxSessions];
}
