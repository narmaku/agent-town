import { readFile, readlink } from "node:fs/promises";
import { createLogger, type TerminalMultiplexer } from "@agent-town/shared";
import {
  extractClaudeSessionIdFromArgs,
  matchSessionByBirthTime,
  type SessionCandidate,
} from "./providers/claude-code/process-mapper";
import { getAllProviders } from "./providers/registry";
import type { AgentProcess } from "./providers/types";
import { resolveSessionName } from "./terminal-server";

const log = createLogger("mapper");

export interface ProcessMapping {
  multiplexer: TerminalMultiplexer;
  session: string; // multiplexer session name
  sessionId?: string; // agent session ID
  hasActiveChildren: boolean;
}

// Re-export for tests
export { extractClaudeSessionIdFromArgs as extractSessionIdFromArgs, matchSessionByBirthTime, type SessionCandidate };

async function getEnvVar(pid: number, varName: string): Promise<string | null> {
  try {
    const env = await readFile(`/proc/${pid}/environ`);
    for (const entry of splitBuffer(env, 0)) {
      const str = entry.toString();
      if (str.startsWith(`${varName}=`)) {
        return str.slice(varName.length + 1);
      }
    }
  } catch (err) {
    log.debug(
      `getEnvVar: pid=${pid} var=${varName} failed (process may have exited): ${err instanceof Error ? err.message : String(err)}`,
    );
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

async function getCwd(pid: number): Promise<string | null> {
  try {
    return await readlink(`/proc/${pid}/cwd`);
  } catch (err) {
    log.debug(
      `getCwd: pid=${pid} failed (process may have exited): ${err instanceof Error ? err.message : String(err)}`,
    );
    return null;
  }
}

export async function runPs(): Promise<AgentProcess[]> {
  const proc = Bun.spawn(["ps", "-eo", "pid,ppid,etimes,args", "--no-headers"], {
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
      const match = line.trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s+(.+)/);
      if (!match) return null;
      return {
        pid: parseInt(match[1], 10),
        ppid: parseInt(match[2], 10),
        etimes: parseInt(match[3], 10),
        args: match[4],
      };
    })
    .filter((x): x is NonNullable<typeof x> => x !== null);
}

/**
 * Resolve the multiplexer session for a process by checking its parent
 * shell's environment variables for ZELLIJ_SESSION_NAME or TMUX.
 */
async function resolveMultiplexerSession(
  proc: AgentProcess,
): Promise<{ multiplexer: TerminalMultiplexer; session: string } | null> {
  const zellijSession = await getEnvVar(proc.ppid, "ZELLIJ_SESSION_NAME");
  if (zellijSession) {
    return { multiplexer: "zellij", session: resolveSessionName(zellijSession) };
  }

  const tmuxEnv = await getEnvVar(proc.ppid, "TMUX");
  if (tmuxEnv) {
    try {
      const ttyLink = await readlink(`/proc/${proc.pid}/fd/0`);
      const tty = ttyLink.split("/").pop();
      const tmuxProc = Bun.spawn(["tmux", "list-panes", "-a", "-F", "#{pane_tty}:#{session_name}"], {
        stdout: "pipe",
        stderr: "pipe",
      });
      const tmuxOutput = await new Response(tmuxProc.stdout).text();
      await tmuxProc.exited;

      for (const line of tmuxOutput.trim().split("\n")) {
        if (tty && line.includes(tty)) {
          const sessionName = line.split(":")[1];
          if (sessionName) {
            return { multiplexer: "tmux", session: sessionName };
          }
          break;
        }
      }
    } catch (err) {
      log.debug(`tmux pane lookup failed for pid=${proc.pid}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  return null;
}

/**
 * Discovers which multiplexer session each running agent process belongs to.
 *
 * Iterates over all registered providers, finds their processes, and matches
 * them to multiplexer sessions and JSONL/DB sessions.
 */
export async function discoverProcessMappings(): Promise<Map<string, ProcessMapping>> {
  const mappings = new Map<string, ProcessMapping>();

  try {
    const allProcesses = await runPs();
    const providers = getAllProviders();

    for (const provider of providers) {
      const agentProcs = provider.filterAgentProcesses(allProcesses);
      // Sort by etimes ascending (newest first)
      agentProcs.sort((a, b) => a.etimes - b.etimes);

      const claimedIds = new Set<string>();

      for (const proc of agentProcs) {
        const cwd = await getCwd(proc.pid);
        if (!cwd) continue;

        const muxInfo = await resolveMultiplexerSession(proc);
        if (!muxInfo) continue;

        const MAX_CHILD_AGE_S = 600;
        const hasActiveChildren = allProcesses.some((p) => p.ppid === proc.pid && p.etimes < MAX_CHILD_AGE_S);

        const mapping: ProcessMapping = {
          multiplexer: muxInfo.multiplexer,
          session: muxInfo.session,
          hasActiveChildren,
        };

        // Determine session ID
        let sessionId = provider.extractSessionIdFromArgs(proc.args);

        // Fallback: let the provider match using its native storage
        if (!sessionId) {
          const processStartMs = Date.now() - proc.etimes * 1000;
          sessionId = await provider.matchProcessToSessionId(cwd, processStartMs, claimedIds);
        }

        if (sessionId) claimedIds.add(sessionId);
        mapping.sessionId = sessionId;

        const key = sessionId || `cwd:${cwd}`;
        mappings.set(key, mapping);
        log.debug(
          `pid=${proc.pid} agent=${provider.type} mux=${mapping.session} key=${key.slice(0, 20)} etimes=${proc.etimes}`,
        );
      }
    }
  } catch (err) {
    log.warn(`discoverProcessMappings failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  return mappings;
}
