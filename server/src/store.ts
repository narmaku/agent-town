import type { Heartbeat, MachineInfo } from "@agent-town/shared";

// How long (ms) before a machine is considered offline
const MACHINE_TIMEOUT_MS = 30_000; // 30 seconds without heartbeat

const machines = new Map<string, MachineInfo>();

// Persists across heartbeats: machineId:sessionId -> custom name
const sessionNames = new Map<string, string>();

function nameKey(machineId: string, sessionId: string): string {
  return `${machineId}:${sessionId}`;
}

export function upsertMachine(heartbeat: Heartbeat): void {
  // Apply any saved custom names to incoming sessions
  const sessions = heartbeat.sessions.map((s) => {
    const saved = sessionNames.get(nameKey(heartbeat.machineId, s.sessionId));
    return saved ? { ...s, customName: saved } : s;
  });

  machines.set(heartbeat.machineId, {
    machineId: heartbeat.machineId,
    hostname: heartbeat.hostname,
    platform: heartbeat.platform,
    lastHeartbeat: heartbeat.timestamp,
    sessions,
    multiplexers: heartbeat.multiplexers,
  });
}

export function renameSession(
  machineId: string,
  sessionId: string,
  name: string
): boolean {
  const key = nameKey(machineId, sessionId);
  if (name.trim() === "") {
    sessionNames.delete(key);
  } else {
    sessionNames.set(key, name.trim());
  }

  // Apply immediately to current state
  const machine = machines.get(machineId);
  if (!machine) return false;

  const session = machine.sessions.find((s) => s.sessionId === sessionId);
  if (!session) return false;

  session.customName = name.trim() || undefined;
  return true;
}

export function getAllMachines(): MachineInfo[] {
  const now = Date.now();
  const result: MachineInfo[] = [];

  for (const [id, machine] of machines) {
    const lastSeen = new Date(machine.lastHeartbeat).getTime();
    if (now - lastSeen > MACHINE_TIMEOUT_MS) {
      machines.delete(id);
      continue;
    }
    result.push(machine);
  }

  return result;
}

export function getMachine(machineId: string): MachineInfo | undefined {
  return machines.get(machineId);
}
