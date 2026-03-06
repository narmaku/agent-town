import { hostname, platform } from "node:os";
import { createHash } from "node:crypto";
import type { Heartbeat } from "@agent-town/shared";
import { discoverSessions } from "./session-parser";
import { detectMultiplexers } from "./multiplexer";

const SERVER_URL = process.env.AGENT_TOWN_SERVER || "http://localhost:4680";
const HEARTBEAT_INTERVAL_MS = Number(process.env.AGENT_TOWN_INTERVAL || "5000");

// Stable machine ID derived from hostname — same machine always gets the same ID
function stableMachineId(): string {
  return createHash("sha256").update(hostname()).digest("hex").slice(0, 16);
}
const MACHINE_ID = process.env.AGENT_TOWN_MACHINE_ID || stableMachineId();

const machineHostname = hostname();
const machinePlatform = platform();

async function sendHeartbeat(): Promise<void> {
  try {
    const [sessions, multiplexers] = await Promise.all([
      discoverSessions(),
      detectMultiplexers(),
    ]);

    const heartbeat: Heartbeat = {
      machineId: MACHINE_ID,
      hostname: machineHostname,
      platform: machinePlatform,
      sessions,
      multiplexers,
      timestamp: new Date().toISOString(),
    };

    const response = await fetch(`${SERVER_URL}/api/heartbeat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(heartbeat),
    });

    if (!response.ok) {
      console.error(`Heartbeat failed: ${response.status} ${response.statusText}`);
    }
  } catch (error) {
    console.error(
      `Heartbeat error: ${error instanceof Error ? error.message : "unknown"}`
    );
  }
}

async function main(): Promise<void> {
  console.log(`Agent Town Agent starting...`);
  console.log(`  Machine ID: ${MACHINE_ID}`);
  console.log(`  Hostname:   ${machineHostname}`);
  console.log(`  Server:     ${SERVER_URL}`);
  console.log(`  Interval:   ${HEARTBEAT_INTERVAL_MS}ms`);

  // Send first heartbeat immediately
  await sendHeartbeat();

  // Then on interval
  setInterval(sendHeartbeat, HEARTBEAT_INTERVAL_MS);
}

main();
