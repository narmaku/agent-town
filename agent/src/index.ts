import { hostname, platform } from "node:os";
import { createHash } from "node:crypto";
import type { Heartbeat } from "@agent-town/shared";
import { discoverSessions } from "./session-parser";
import { detectMultiplexers, listAllSessions } from "./multiplexer";
import { discoverProcessMappings } from "./process-mapper";
import { startTerminalServer } from "./terminal-server";

const SERVER_URL = process.env.AGENT_TOWN_SERVER || "http://localhost:4680";
const HEARTBEAT_INTERVAL_MS = Number(process.env.AGENT_TOWN_INTERVAL || "5000");
const TERMINAL_PORT = Number(process.env.AGENT_TOWN_TERMINAL_PORT || "4681");

// Stable machine ID derived from hostname — same machine always gets the same ID
function stableMachineId(): string {
  return createHash("sha256").update(hostname()).digest("hex").slice(0, 16);
}
const MACHINE_ID = process.env.AGENT_TOWN_MACHINE_ID || stableMachineId();

const machineHostname = hostname();
const machinePlatform = platform();

async function sendHeartbeat(): Promise<void> {
  try {
    const [sessions, multiplexers, multiplexerSessions, processMappings] =
      await Promise.all([
        discoverSessions(),
        detectMultiplexers(),
        listAllSessions(),
        discoverProcessMappings(),
      ]);

    // Enrich sessions with their multiplexer mapping (auto-discovered)
    for (const session of sessions) {
      const mapping = processMappings.get(session.projectPath);
      if (mapping) {
        session.multiplexer = mapping.multiplexer;
        session.multiplexerSession = mapping.session;
      }
    }

    // Only include active (non-exited) multiplexer sessions
    const activeMuxSessions = multiplexerSessions.filter((s) => s.attached);

    const heartbeat: Heartbeat = {
      machineId: MACHINE_ID,
      hostname: machineHostname,
      platform: machinePlatform,
      sessions,
      multiplexers,
      multiplexerSessions: activeMuxSessions,
      terminalPort: TERMINAL_PORT,
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

  // Start the terminal WebSocket server
  startTerminalServer(TERMINAL_PORT, MACHINE_ID);

  // Send first heartbeat immediately
  await sendHeartbeat();

  // Then on interval
  setInterval(sendHeartbeat, HEARTBEAT_INTERVAL_MS);
}

main();
