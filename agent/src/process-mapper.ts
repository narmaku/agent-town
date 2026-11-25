import { readFile, readlink } from "node:fs/promises";
import { type AgentType, createLogger, errorMessage, type TerminalMultiplexer } from "@agent-town/shared";
import { listTmuxPanes, type TmuxPaneInfo } from "./multiplexer";
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
  agentType: AgentType; // agent type that owns this process
}

export type ProcessMappingKeyKind = "session" | "cwd";

export function makeProcessMappingKey(agentType: AgentType, kind: ProcessMappingKeyKind, value: string): string {
  return `${agentType}:${kind}:${value}`;
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
    log.debug(`getEnvVar: pid=${pid} var=${varName} failed (process may have exited): ${errorMessage(err)}`);
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
    log.debug(`getCwd: pid=${pid} failed (process may have exited): ${errorMessage(err)}`);
    return null;
  }
}

export async function runPs(): Promise<AgentProcess[]> {
  const proc = Bun.spawn(["ps", "-eo", "pid,ppid,etimes,args", "--no-headers"], {
    stdout: "pipe",
    stderr: "ignore",
  });
  const output = await Bun.readableStreamToText(proc.stdout);
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
  tmuxPanes: readonly TmuxPaneInfo[],
): Promise<{ multiplexer: TerminalMultiplexer; session: string } | null> {
  const zellijSession = await getEnvVar(proc.ppid, "ZELLIJ_SESSION_NAME");
  if (zellijSession) {
    return { multiplexer: "zellij", session: resolveSessionName(zellijSession) };
  }

  const tmuxEnv = await getEnvVar(proc.ppid, "TMUX");
  if (tmuxEnv) {
    try {
      const ttyLink = await readlink(`/proc/${proc.pid}/fd/0`);
      const pane = tmuxPanes.find((candidate) => candidate.tty === ttyLink);
      if (pane) return { multiplexer: "tmux", session: pane.session };
    } catch (err) {
      log.debug(`tmux pane lookup failed for pid=${proc.pid}: ${errorMessage(err)}`);
    }
  }

  return null;
}

/**
 * Resolve the owning terminal through pane ancestry when a restricted service
 * cannot read another process's /proc cwd, environment or terminal descriptors.
 * A shared working directory alone is never evidence of pane ownership.
 */
export async function resolveProcessContext(
  proc: AgentProcess,
  allProcesses: readonly AgentProcess[],
  tmuxPanes: readonly TmuxPaneInfo[],
): Promise<{ cwd: string; multiplexer: TerminalMultiplexer; session: string } | null> {
  const processesByPid = new Map(allProcesses.map((process) => [process.pid, process]));
  const visited = new Set<number>();
  let pid = proc.pid;
  let pane: TmuxPaneInfo | undefined;
  while (pid > 1 && !visited.has(pid)) {
    visited.add(pid);
    pane = tmuxPanes.find((candidate) => candidate.pid === pid);
    if (pane) break;
    const parent = processesByPid.get(pid);
    if (!parent) break;
    pid = parent.ppid;
  }

  const cwd = (await getCwd(proc.pid)) ?? pane?.cwd;
  if (!cwd) return null;
  const muxInfo = pane
    ? { multiplexer: "tmux" as const, session: pane.session }
    : await resolveMultiplexerSession(proc, tmuxPanes);
  return muxInfo ? { ...muxInfo, cwd } : null;
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
    const [allProcesses, tmuxPanes] = await Promise.all([runPs(), listTmuxPanes()]);
    const providers = getAllProviders();

    // Collect all agent PIDs across providers so we can detect sub-agents
    // (processes whose parent is another agent process, e.g. Claude Code
    // Agent tool spawns). Sub-agents inherit ZELLIJ_SESSION_NAME from their
    // parent but should not be independently mapped to multiplexer sessions.
    const allAgentPids = new Set<number>();
    for (const provider of providers) {
      for (const proc of provider.filterAgentProcesses(allProcesses)) {
        allAgentPids.add(proc.pid);
      }
    }

    for (const provider of providers) {
      const agentProcs = provider.filterAgentProcesses(allProcesses);
      // Sort by etimes ascending (newest first)
      agentProcs.sort((a, b) => a.etimes - b.etimes);

      const claimedIds = new Set<string>();

      for (const proc of agentProcs) {
        // Skip sub-agents: if the parent process is also an agent, this is
        // a child spawned via the Agent tool and should not be tracked independently
        if (allAgentPids.has(proc.ppid)) {
          log.debug(`skipping sub-agent: pid=${proc.pid} ppid=${proc.ppid} agent=${provider.type}`);
          continue;
        }
        const context = await resolveProcessContext(proc, allProcesses, tmuxPanes);
        if (!context) continue;
        const { cwd } = context;

        const MAX_CHILD_AGE_S = 600;
        const hasActiveChildren = allProcesses.some((p) => p.ppid === proc.pid && p.etimes < MAX_CHILD_AGE_S);

        const mapping: ProcessMapping = {
          multiplexer: context.multiplexer,
          session: context.session,
          hasActiveChildren,
          agentType: provider.type,
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

        const key = makeProcessMappingKey(provider.type, sessionId ? "session" : "cwd", sessionId || cwd);
        mappings.set(key, mapping);
        log.debug(
          `pid=${proc.pid} agent=${provider.type} mux=${mapping.session} key=${key.slice(0, 20)} etimes=${proc.etimes}`,
        );
      }
    }
  } catch (err) {
    log.warn(`discoverProcessMappings failed: ${errorMessage(err)}`);
  }

  return mappings;
}
