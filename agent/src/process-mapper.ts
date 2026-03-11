import { readFile, readlink } from "node:fs/promises";
import type { TerminalMultiplexer } from "@agent-town/shared";

interface ProcessMapping {
  pid: number;
  cwd: string;
  multiplexer: TerminalMultiplexer | null;
  multiplexerSession: string | null;
}

async function getEnvVar(pid: number, varName: string): Promise<string | null> {
  try {
    const env = await readFile(`/proc/${pid}/environ`);
    const prefix = Buffer.from(`${varName}=`);
    for (const entry of splitBuffer(env, 0)) {
      const str = entry.toString();
      if (str.startsWith(`${varName}=`)) {
        return str.slice(varName.length + 1);
      }
    }
  } catch {
    // Process may have exited or we don't have permission
  }
  return null;
}

function* splitBuffer(buf: Buffer, _sep: number): Generator<Buffer> {
  let start = 0;
  for (let i = 0; i < buf.length; i++) {
    if (buf[i] === 0) {
      if (i > start) yield buf.subarray(start, i);
      start = i + 1;
    }
  }
  if (start < buf.length) yield buf.subarray(start);
}

async function getPpid(pid: number): Promise<number | null> {
  try {
    const stat = await readFile(`/proc/${pid}/stat`, "utf-8");
    // Format: pid (comm) state ppid ...
    // comm can contain spaces/parens, so find the last ) then parse
    const lastParen = stat.lastIndexOf(")");
    const rest = stat.slice(lastParen + 2).split(" ");
    return parseInt(rest[1]); // ppid is the 2nd field after state
  } catch {
    return null;
  }
}

async function getCwd(pid: number): Promise<string | null> {
  try {
    return await readlink(`/proc/${pid}/cwd`);
  } catch {
    return null;
  }
}

async function runPs(): Promise<
  Array<{ pid: number; ppid: number; args: string }>
> {
  const proc = Bun.spawn(["ps", "-eo", "pid,ppid,args", "--no-headers"], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const output = await new Response(proc.stdout).text();
  await proc.exited;

  return output
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const parts = line.trim().split(/\s+/, 3);
      if (parts.length < 3) return null;
      return {
        pid: parseInt(parts[0]),
        ppid: parseInt(parts[1]),
        args: parts[2],
      };
    })
    .filter((x): x is NonNullable<typeof x> => x !== null);
}

/**
 * Discovers which multiplexer session each running Claude Code process
 * belongs to by checking the parent shell's environment variables.
 *
 * Returns a map of projectPath -> { multiplexer, session }
 */
export async function discoverProcessMappings(): Promise<
  Map<string, { multiplexer: TerminalMultiplexer; session: string }>
> {
  const mappings = new Map<
    string,
    { multiplexer: TerminalMultiplexer; session: string }
  >();

  try {
    const processes = await runPs();

    // Find all "claude" processes (the main CLI, not subprocesses)
    const claudeProcs = processes.filter((p) => {
      const bin = p.args.split("/").pop()?.split(" ")[0];
      return bin === "claude";
    });

    for (const proc of claudeProcs) {
      const cwd = await getCwd(proc.pid);
      if (!cwd) continue;

      // Check parent shell for multiplexer session info
      const zellijSession = await getEnvVar(proc.ppid, "ZELLIJ_SESSION_NAME");
      if (zellijSession) {
        mappings.set(cwd, { multiplexer: "zellij", session: zellijSession });
        continue;
      }

      const tmuxEnv = await getEnvVar(proc.ppid, "TMUX");
      if (tmuxEnv) {
        // For tmux, get the session name by checking which pane this process is in
        try {
          const ttyLink = await readlink(`/proc/${proc.pid}/fd/0`);
          const tty = ttyLink.split("/").pop();
          const tmuxProc = Bun.spawn(
            [
              "tmux",
              "list-panes",
              "-a",
              "-F",
              "#{pane_tty}:#{session_name}",
            ],
            { stdout: "pipe", stderr: "pipe" }
          );
          const tmuxOutput = await new Response(tmuxProc.stdout).text();
          await tmuxProc.exited;

          for (const line of tmuxOutput.trim().split("\n")) {
            if (tty && line.includes(tty)) {
              const sessionName = line.split(":")[1];
              if (sessionName) {
                mappings.set(cwd, {
                  multiplexer: "tmux",
                  session: sessionName,
                });
              }
              break;
            }
          }
        } catch {
          // tmux not available or pane lookup failed
        }
        continue;
      }
    }
  } catch {
    // ps command failed or /proc not available
  }

  return mappings;
}
