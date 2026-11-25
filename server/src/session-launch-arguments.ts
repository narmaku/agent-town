import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  type AgentType,
  createLogger,
  errorMessage,
  isRecord,
  type MachineInfo,
  resolveExtraLaunchArgs,
  type SessionInfo,
  type TerminalMultiplexer,
} from "@agent-town/shared";
import { resolveDataDir } from "@agent-town/shared/data-dir";

const log = createLogger("session-launch-arguments");
const DISCOVERY_GRACE_MS = 60_000;

interface Launch {
  machineId: string;
  agentType: AgentType;
  multiplexer: TerminalMultiplexer;
  sessionName: string;
  extraArgs?: string[];
}

interface PendingLaunch extends Launch {
  extraArgs: string[];
  previousSessionIds: string[];
  recordedAt: number;
}

type ObservedMachine = Pick<MachineInfo, "machineId" | "sessions" | "multiplexerSessions">;

export class SessionLaunchArguments {
  private readonly path: string;
  private readonly pending = new Map<string, PendingLaunch>();
  private readonly sessions = new Map<string, string[]>();

  constructor(private readonly dataDir: string) {
    this.path = join(dataDir, "session-launch-arguments.json");
    try {
      const data: unknown = JSON.parse(readFileSync(this.path, "utf-8"));
      if (!isRecord(data) || !isRecord(data.pending) || !isRecord(data.sessions)) return;
      for (const [key, value] of Object.entries(data.pending)) {
        if (
          isRecord(value) &&
          typeof value.machineId === "string" &&
          typeof value.agentType === "string" &&
          typeof value.multiplexer === "string" &&
          typeof value.sessionName === "string" &&
          typeof value.recordedAt === "number" &&
          Array.isArray(value.previousSessionIds) &&
          resolveExtraLaunchArgs(value.extraArgs)?.length
        ) {
          this.pending.set(key, value as unknown as PendingLaunch);
        }
      }
      for (const [key, value] of Object.entries(data.sessions)) {
        const args = resolveExtraLaunchArgs(value);
        if (args?.length) this.sessions.set(key, args);
      }
    } catch (err) {
      log.debug(`could not load saved arguments: ${errorMessage(err)}`);
    }
  }

  record(launch: Launch, previousSessions: SessionInfo[], current?: ObservedMachine): void {
    const key = JSON.stringify([launch.machineId, launch.multiplexer, launch.sessionName]);
    if (!launch.extraArgs?.length) {
      if (this.pending.delete(key)) this.save();
      return;
    }

    this.pending.set(key, {
      ...launch,
      extraArgs: launch.extraArgs,
      previousSessionIds: previousSessions.filter((s) => s.agentType === launch.agentType).map((s) => s.sessionId),
      recordedAt: Date.now(),
    });
    if (current) this.match(current);
    this.save();
  }

  reconcile(machine: ObservedMachine): void {
    if (this.match(machine)) this.save();
  }

  get(machineId: string, agentType: AgentType, sessionId: string): string[] | undefined {
    return this.sessions.get(JSON.stringify([machineId, agentType, sessionId]));
  }

  forget(machineId: string, agentType: AgentType, sessionId: string): void {
    if (this.sessions.delete(JSON.stringify([machineId, agentType, sessionId]))) this.save();
  }

  forgetPending(machineId: string, multiplexer: string, sessionName: string): void {
    if (this.pending.delete(JSON.stringify([machineId, multiplexer, sessionName]))) this.save();
  }

  renamePending(machineId: string, multiplexer: string, oldName: string, newName: string): void {
    const oldKey = JSON.stringify([machineId, multiplexer, oldName]);
    const pending = this.pending.get(oldKey);
    if (!pending) return;
    this.pending.delete(oldKey);
    this.pending.set(JSON.stringify([machineId, multiplexer, newName]), { ...pending, sessionName: newName });
    this.save();
  }

  private match(machine: ObservedMachine): boolean {
    let changed = false;
    for (const [key, launch] of this.pending) {
      if (machine.machineId !== launch.machineId) continue;
      const candidates = machine.sessions.filter(
        (session) =>
          session.agentType === launch.agentType &&
          session.multiplexer === launch.multiplexer &&
          session.multiplexerSession === launch.sessionName &&
          !session.sessionId.startsWith("pending-") &&
          !launch.previousSessionIds.includes(session.sessionId),
      );
      if (candidates.length === 1) {
        const sessionKey = JSON.stringify([machine.machineId, launch.agentType, candidates[0].sessionId]);
        if (!this.sessions.has(sessionKey)) this.sessions.set(sessionKey, launch.extraArgs);
      } else if (
        Date.now() - launch.recordedAt < DISCOVERY_GRACE_MS ||
        machine.multiplexerSessions.some(
          (mux) => mux.multiplexer === launch.multiplexer && mux.name === launch.sessionName,
        )
      ) {
        continue;
      }
      this.pending.delete(key);
      changed = true;
    }
    return changed;
  }

  private save(): void {
    try {
      mkdirSync(this.dataDir, { recursive: true });
      const temporary = `${this.path}.${process.pid}.tmp`;
      const data = { pending: Object.fromEntries(this.pending), sessions: Object.fromEntries(this.sessions) };
      writeFileSync(temporary, JSON.stringify(data), { mode: 0o600 });
      renameSync(temporary, this.path);
    } catch (err) {
      log.warn(`could not save session launch arguments: ${errorMessage(err)}`);
    }
  }
}

export const sessionLaunchArguments = new SessionLaunchArguments(resolveDataDir());
