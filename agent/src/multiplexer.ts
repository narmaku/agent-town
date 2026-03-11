import type { TerminalMultiplexer, MultiplexerSessionInfo } from "@agent-town/shared";

async function runCommand(cmd: string[]): Promise<string> {
  const proc = Bun.spawn(cmd, {
    stdout: "pipe",
    stderr: "pipe",
  });
  const output = await new Response(proc.stdout).text();
  await proc.exited;
  return output.trim();
}

async function isAvailable(binary: string): Promise<boolean> {
  try {
    const proc = Bun.spawn(["which", binary], { stdout: "pipe", stderr: "pipe" });
    await proc.exited;
    return proc.exitCode === 0;
  } catch {
    return false;
  }
}

export async function detectMultiplexers(): Promise<TerminalMultiplexer[]> {
  const result: TerminalMultiplexer[] = [];
  if (await isAvailable("zellij")) result.push("zellij");
  if (await isAvailable("tmux")) result.push("tmux");
  return result;
}

export async function listZellijSessions(): Promise<MultiplexerSessionInfo[]> {
  try {
    const output = await runCommand(["zellij", "list-sessions", "--short"]);
    if (!output) return [];
    return output.split("\n").filter(Boolean).map((line) => {
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
  } catch {
    return [];
  }
}

export async function listTmuxSessions(): Promise<MultiplexerSessionInfo[]> {
  try {
    const output = await runCommand([
      "tmux",
      "list-sessions",
      "-F",
      "#{session_name}:#{session_attached}",
    ]);
    if (!output) return [];
    return output.split("\n").filter(Boolean).map((line) => {
      const [name, attached] = line.split(":");
      return {
        name: name || "",
        multiplexer: "tmux" as const,
        attached: attached === "1",
      };
    });
  } catch {
    return [];
  }
}

export async function listAllSessions(): Promise<MultiplexerSessionInfo[]> {
  const [zellijSessions, tmuxSessions] = await Promise.all([
    listZellijSessions(),
    listTmuxSessions(),
  ]);
  return [...zellijSessions, ...tmuxSessions];
}
