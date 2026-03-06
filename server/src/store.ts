import type { Heartbeat, MachineInfo } from "@agent-town/shared";

// How long (ms) before a machine is considered offline
const MACHINE_TIMEOUT_MS = 30_000; // 30 seconds without heartbeat

const machines = new Map<string, MachineInfo>();

export function upsertMachine(heartbeat: Heartbeat): void {
  machines.set(heartbeat.machineId, {
    machineId: heartbeat.machineId,
    hostname: heartbeat.hostname,
    platform: heartbeat.platform,
    lastHeartbeat: heartbeat.timestamp,
    sessions: heartbeat.sessions,
    multiplexers: heartbeat.multiplexers,
  });
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
