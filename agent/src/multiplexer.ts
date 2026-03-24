import { createLogger, type MultiplexerSessionInfo, type TerminalMultiplexer } from "@agent-town/shared";

const log = createLogger("multiplexer");

async function runCommand(cmd: string[]): Promise<string> {
  const proc = Bun.spawn(cmd, {
    stdout: "pipe",
    stderr: "ignore",
  });
  const output = await new Response(proc.stdout).text();
  await proc.exited;
  return output.trim();
}

async function isAvailable(binary: string): Promise<boolean> {
  try {
    const proc = Bun.spawn(["which", binary], { stdout: "pipe", stderr: "ignore" });
    await proc.exited;
    return proc.exitCode === 0;
  } catch (err) {
    log.debug(`which ${binary} failed: ${err instanceof Error ? err.message : String(err)}`);
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
    log.debug(`zellij list-sessions failed: ${err instanceof Error ? err.message : String(err)}`);
    return [];
  }
}

export async function listTmuxSessions(): Promise<MultiplexerSessionInfo[]> {
  try {
    const output = await runCommand(["tmux", "list-sessions", "-F", "#{session_name}:#{session_attached}"]);
    if (!output) return [];
    const sessions = output
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const [name, attached] = line.split(":");
        return {
          name: name || "",
          multiplexer: "tmux" as const,
          attached: attached === "1",
        };
      });
    log.debug(`tmux: found ${sessions.length} session(s)`);
    return sessions;
  } catch (err) {
    log.debug(`tmux list-sessions failed: ${err instanceof Error ? err.message : String(err)}`);
    return [];
  }
}

export async function listAllSessions(): Promise<MultiplexerSessionInfo[]> {
  const [zellijSessions, tmuxSessions] = await Promise.all([listZellijSessions(), listTmuxSessions()]);
  return [...zellijSessions, ...tmuxSessions];
}
