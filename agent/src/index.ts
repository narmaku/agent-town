import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, hostname, platform } from "node:os";
import { join } from "node:path";
import {
  createLogger,
  type Heartbeat,
  type MultiplexerSessionInfo,
  type SessionInfo,
  type TerminalMultiplexer,
  truncateId,
} from "@agent-town/shared";
import { getHookState, updateHookState } from "./hook-store";
import { detectMultiplexers, listAllSessions } from "./multiplexer";
import { createPlaceholderSessions } from "./placeholder-sessions";
import { discoverProcessMappings, type ProcessMapping } from "./process-mapper";
import type { OpenCodeProvider } from "./providers/opencode/index";
import { getAllProviders, getProvider, initializeProviders } from "./providers/registry";
import { discoverSessions } from "./session-parser";
import { startTerminalServer } from "./terminal-server";

const log = createLogger("agent");

const SERVER_URL = process.env.AGENT_TOWN_SERVER || "http://localhost:4680";
const HEARTBEAT_INTERVAL_MS = Number(process.env.AGENT_TOWN_INTERVAL || "5000");
const TERMINAL_PORT = Number(process.env.AGENT_TOWN_TERMINAL_PORT || "4681");

function stableMachineId(): string {
  return createHash("sha256").update(hostname()).digest("hex").slice(0, 16);
}
const MACHINE_ID = process.env.AGENT_TOWN_MACHINE_ID || stableMachineId();

const machineHostname = hostname();
const machinePlatform = platform();

// --- Last-known multiplexer session tracking ---
//
// Tracks which mux session each JSONL session was last seen in.
// When Claude exits but the mux session stays alive, this lets us
// detect the "exited" state and offer reconnection.
// Persisted to disk so it survives agent restarts.
interface MuxAssociation {
  session: string;
  multiplexer: TerminalMultiplexer;
}

const MUX_ASSOC_DIR = join(homedir(), ".agent-town");
const MUX_ASSOC_FILE = join(MUX_ASSOC_DIR, "last-known-mux.json");
const lastKnownMux = new Map<string, MuxAssociation>();

function loadLastKnownMux(): void {
  try {
    const data = readFileSync(MUX_ASSOC_FILE, "utf-8");
    const parsed = JSON.parse(data) as Record<string, MuxAssociation>;
    for (const [key, value] of Object.entries(parsed)) {
      lastKnownMux.set(key, value);
    }
  } catch (err) {
    log.debug(`last-known mux not loaded: ${err instanceof Error ? err.message : String(err)}`);
  }
}

function saveLastKnownMux(): void {
  try {
    mkdirSync(MUX_ASSOC_DIR, { recursive: true });
    const obj: Record<string, MuxAssociation> = {};
    for (const [key, value] of lastKnownMux) {
      obj[key] = value;
    }
    writeFileSync(MUX_ASSOC_FILE, JSON.stringify(obj, null, 2));
  } catch (err) {
    log.warn(`failed to save last-known mux: ${err instanceof Error ? err.message : String(err)}`);
  }
}

loadLastKnownMux();

// Session names persisted by the server (custom names from dashboard renames
// and auto-populated multiplexer session names). Used for name-matching
// when detecting exited sessions.
const SESSION_NAMES_FILE = join(homedir(), ".agent-town", "session-names.json");

function loadSessionNames(): Record<string, string> {
  try {
    const data = readFileSync(SESSION_NAMES_FILE, "utf-8");
    return JSON.parse(data) as Record<string, string>;
  } catch (err) {
    log.debug(`session names not loaded: ${err instanceof Error ? err.message : String(err)}`);
    return {};
  }
}

// --- Heartbeat helper functions ---
//
// Each function handles one phase of the heartbeat pipeline.
// They are called sequentially from sendHeartbeat().

/**
 * Discover sessions from all providers and map them to multiplexer sessions
 * using process-level inspection. Validates that mapped multiplexer sessions
 * actually exist (rejects zombie process associations).
 */
function discoverAndMapSessions(
  sessions: SessionInfo[],
  multiplexerSessions: MultiplexerSessionInfo[],
  processMappings: Map<string, ProcessMapping>,
): Set<string> {
  const activeMuxNames = new Set(multiplexerSessions.map((s) => s.name));
  log.debug(`active mux sessions: [${[...activeMuxNames].join(", ")}]`);

  for (const session of sessions) {
    const mapping = processMappings.get(session.sessionId);
    if (mapping) {
      if (activeMuxNames.has(mapping.session)) {
        session.multiplexer = mapping.multiplexer;
        session.multiplexerSession = mapping.session;
      } else {
        log.debug(
          `rejected mapping: session=${truncateId(session.sessionId)} mux=${mapping.session} (not in active mux list)`,
        );
      }
    }
  }

  return activeMuxNames;
}

/**
 * Adjust session statuses using the priority chain:
 * 1. Hook events (real-time, accurate — if hooks are enabled)
 * 2. Process mapper (child process detection — fallback heuristic)
 * 3. JSONL file modification time (least accurate — base heuristic)
 */
function adjustSessionStatuses(sessions: SessionInfo[], processMappings: Map<string, ProcessMapping>): void {
  for (const session of sessions) {
    // Check if hooks are providing real-time status for this session
    const hookState = getHookState(session.sessionId);
    if (hookState) {
      session.hookEnabled = true;
      session.status = hookState.status;
      session.currentTool = hookState.currentTool;
      continue;
    }

    // Fallback: process mapper + storage heuristics
    if (session.multiplexerSession) {
      const mapping = processMappings.get(session.sessionId);

      if (mapping?.hasActiveChildren) {
        session.status = "working";
      } else if (session.status === "idle") {
        session.status = "awaiting_input";
      }
    } else {
      session.status = "idle";
    }
  }
}

/**
 * Track session-to-multiplexer associations and detect exited sessions.
 * When an agent exits but the mux session stays alive, marks the session
 * as "exited" so the dashboard can offer reconnection.
 */
function trackMultiplexerAssociations(sessions: SessionInfo[], multiplexerSessions: MultiplexerSessionInfo[]): void {
  let muxAssocChanged = false;
  for (const session of sessions) {
    if (session.multiplexerSession && session.multiplexer) {
      const prev = lastKnownMux.get(session.sessionId);
      if (!prev || prev.session !== session.multiplexerSession) {
        lastKnownMux.set(session.sessionId, {
          session: session.multiplexerSession,
          multiplexer: session.multiplexer,
        });
        muxAssocChanged = true;
      }
    }
  }

  // Build set of mux session names already claimed by a running Claude process
  const claimedMuxNames = new Set(sessions.filter((s) => s.multiplexerSession).map((s) => s.multiplexerSession));

  // Build lookup for unclaimed mux sessions (both active AND EXITED).
  // EXITED sessions are included so the dashboard can detect when an
  // agent process exits but the mux session still exists.
  const allMuxNames = new Set(multiplexerSessions.map((s) => s.name));
  const unclaimedMuxLookup = new Map<string, TerminalMultiplexer>();
  for (const muxSession of multiplexerSessions) {
    if (!claimedMuxNames.has(muxSession.name)) {
      unclaimedMuxLookup.set(muxSession.name, muxSession.multiplexer);
    }
  }

  const savedNames = loadSessionNames();

  for (const session of sessions) {
    if (session.multiplexerSession) continue; // Has a running Claude process

    // Detection path 1: lastKnownMux (historical tracking)
    const lastMux = lastKnownMux.get(session.sessionId);
    if (lastMux && unclaimedMuxLookup.has(lastMux.session) && !claimedMuxNames.has(lastMux.session)) {
      session.multiplexer = lastMux.multiplexer;
      session.multiplexerSession = lastMux.session;
      // Only set "exited" if session isn't already "done" (hook-based done takes priority)
      if (session.status !== "done") {
        session.status = "exited";
      }
      claimedMuxNames.add(lastMux.session);
      log.info(`exited (tracked): session=${truncateId(session.sessionId)} mux=${lastMux.session}`);
      continue;
    }

    // Detection path 2: name matching — check all known names for this session
    // against unclaimed mux session names. Handles sessions that existed before
    // tracking was added, and sessions whose customName is only in session-names.json.
    const nameCandidates = [savedNames[session.sessionId], session.customName, session.slug].filter(Boolean);
    const matchedName = nameCandidates.find((n) => n != null && unclaimedMuxLookup.has(n));
    const muxType = matchedName ? unclaimedMuxLookup.get(matchedName) : undefined;
    if (matchedName && muxType) {
      session.multiplexer = muxType;
      session.multiplexerSession = matchedName;
      if (session.status !== "done") {
        session.status = "exited";
      }
      claimedMuxNames.add(matchedName);
      unclaimedMuxLookup.delete(matchedName);
      // Also record for future tracking
      lastKnownMux.set(session.sessionId, { session: matchedName, multiplexer: muxType });
      muxAssocChanged = true;
      log.info(`exited (name match): session=${truncateId(session.sessionId)} mux=${matchedName}`);
    }
  }

  // Clean up stale entries: remove associations for mux sessions that no longer exist
  for (const [sessionId, assoc] of lastKnownMux) {
    if (!allMuxNames.has(assoc.session)) {
      lastKnownMux.delete(sessionId);
      muxAssocChanged = true;
    }
  }

  if (muxAssocChanged) saveLastKnownMux();
}

async function sendHeartbeat(): Promise<void> {
  try {
    const [sessions, multiplexers, multiplexerSessions, processMappings] = await Promise.all([
      discoverSessions(),
      detectMultiplexers(),
      listAllSessions(),
      discoverProcessMappings(),
    ]);

    const activeMuxNames = discoverAndMapSessions(sessions, multiplexerSessions, processMappings);
    adjustSessionStatuses(sessions, processMappings);
    trackMultiplexerAssociations(sessions, multiplexerSessions);
    createPlaceholderSessions(sessions, processMappings, activeMuxNames);

    // Only include active (non-exited) multiplexer sessions
    const activeMuxSessions = multiplexerSessions.filter((s) => s.attached);

    const heartbeat: Heartbeat = {
      machineId: MACHINE_ID,
      hostname: machineHostname,
      platform: machinePlatform,
      sessions,
      multiplexers,
      multiplexerSessions: activeMuxSessions,
      availableAgents: getAllProviders().map((p) => p.type),
      terminalPort: TERMINAL_PORT,
      timestamp: new Date().toISOString(),
    };

    const response = await fetch(`${SERVER_URL}/api/heartbeat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(heartbeat),
    });

    // Log heartbeat summary at debug level (runs every 5s)
    const mapped = sessions.filter((s) => s.multiplexerSession).length;
    const rejected = processMappings.size - mapped;
    log.debug(
      `heartbeat: ${sessions.length} sessions, ${processMappings.size} processes, ${mapped} mapped, ${rejected} unmatched`,
    );

    if (!response.ok) {
      log.error(`heartbeat failed: ${response.status} ${response.statusText}`);
    }
  } catch (error) {
    log.error(`heartbeat error: ${error instanceof Error ? error.message : "unknown"}`);
  }
}

async function main(): Promise<void> {
  log.info(
    `starting — machine=${MACHINE_ID} host=${machineHostname} server=${SERVER_URL} interval=${HEARTBEAT_INTERVAL_MS}ms`,
  );

  // Initialize agent providers (Claude Code, OpenCode, etc.)
  await initializeProviders();

  // Start OpenCode SSE event subscription for real-time status
  const openCodeProvider = getProvider("opencode") as OpenCodeProvider | undefined;
  if (openCodeProvider?.startEventStream) {
    openCodeProvider.startEventStream((result) => {
      updateHookState(result);
    });
  }

  startTerminalServer(TERMINAL_PORT, MACHINE_ID);

  await sendHeartbeat();
  setInterval(sendHeartbeat, HEARTBEAT_INTERVAL_MS);
}

main();
