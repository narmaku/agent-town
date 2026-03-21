import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import {
  type CreateNodeRequest,
  createLogger,
  type Heartbeat,
  type MachineInfo,
  type NodeStatus,
  type RemoteNode,
  type Settings,
  type UpdateNodeRequest,
} from "@agent-town/shared";

const log = createLogger("store");

// How long (ms) before a machine is considered offline
const MACHINE_TIMEOUT_MS = 30_000; // 30 seconds without heartbeat

const machines = new Map<string, MachineInfo>();

// --- Pending sessions ---
// Tracks sessions that have been launched but haven't appeared in a heartbeat yet.
// Injected into getAllMachines() so the dashboard shows them immediately.

interface PendingSession {
  machineId: string;
  sessionName: string;
  projectDir: string;
  multiplexer: "zellij" | "tmux";
  createdAt: number;
}

const PENDING_SESSION_TIMEOUT_MS = 60_000; // remove after 60s if never matched
const pendingSessions = new Map<string, PendingSession>(); // key: "machineId:sessionName"

// Persists across heartbeats and server restarts: sessionId -> custom name
// Keyed by sessionId alone (not machineId:sessionId) so names survive
// agent restarts that change the machineId
const SESSION_NAMES_DIR = join(homedir(), ".agent-town");
const SESSION_NAMES_FILE = join(SESSION_NAMES_DIR, "session-names.json");

const sessionNames = new Map<string, string>();

function loadSessionNames(): void {
  try {
    const data = readFileSync(SESSION_NAMES_FILE, "utf-8");
    const parsed = JSON.parse(data) as Record<string, string>;
    for (const [key, value] of Object.entries(parsed)) {
      sessionNames.set(key, value);
    }
    log.info(`loaded ${sessionNames.size} session name(s) from ${SESSION_NAMES_FILE}`);
  } catch (err) {
    log.debug(`session names file not loaded: ${err instanceof Error ? err.message : String(err)}`);
  }
}

function saveSessionNames(): void {
  try {
    mkdirSync(SESSION_NAMES_DIR, { recursive: true });
    const obj: Record<string, string> = {};
    for (const [key, value] of sessionNames) {
      obj[key] = value;
    }
    writeFileSync(SESSION_NAMES_FILE, JSON.stringify(obj, null, 2));
  } catch (err) {
    log.warn(`failed to save session names: ${err instanceof Error ? err.message : String(err)}`);
  }
}

// Load on startup
loadSessionNames();

export function addPendingSession(
  machineId: string,
  sessionName: string,
  projectDir: string,
  multiplexer: "zellij" | "tmux",
): void {
  const key = `${machineId}:${sessionName}`;
  pendingSessions.set(key, {
    machineId,
    sessionName,
    projectDir,
    multiplexer,
    createdAt: Date.now(),
  });
  log.info(`pending: added session=${sessionName} machine=${machineId.slice(0, 8)}`);
}

export function upsertMachine(heartbeat: Heartbeat): void {
  // Deduplicate by hostname: if another machineId has the same hostname,
  // remove the old entry (happens when agent restarts with a different ID)
  for (const [existingId, existing] of machines) {
    if (existing.hostname === heartbeat.hostname && existingId !== heartbeat.machineId) {
      machines.delete(existingId);
    }
  }

  // Apply custom names to incoming sessions:
  // 1. Use saved custom name if available (persisted across restarts)
  // 2. Fall back to multiplexer session name (auto-populate + persist)
  let didPersist = false;
  const sessions = heartbeat.sessions.map((s) => {
    const saved = sessionNames.get(s.sessionId);
    if (saved) {
      return { ...s, customName: saved };
    }
    // Auto-populate from multiplexer session name and persist it so the
    // name survives even when the multiplexer session is killed/closed.
    if (s.multiplexerSession) {
      sessionNames.set(s.sessionId, s.multiplexerSession);
      didPersist = true;
      return { ...s, customName: s.multiplexerSession };
    }
    return s;
  });
  if (didPersist) saveSessionNames();

  machines.set(heartbeat.machineId, {
    machineId: heartbeat.machineId,
    hostname: heartbeat.hostname,
    platform: heartbeat.platform,
    lastHeartbeat: heartbeat.timestamp,
    sessions,
    multiplexers: heartbeat.multiplexers,
    multiplexerSessions: heartbeat.multiplexerSessions,
    terminalPort: heartbeat.terminalPort,
  });

  // Remove pending sessions that now appear in heartbeat data
  // (matched by multiplexer session name on this machine)
  const muxNames = new Set(sessions.map((s) => s.multiplexerSession).filter(Boolean));
  for (const [key, pending] of pendingSessions) {
    if (pending.machineId !== heartbeat.machineId) continue;
    if (muxNames.has(pending.sessionName)) {
      pendingSessions.delete(key);
      log.info(`pending: matched session=${pending.sessionName} (removed)`);
    }
  }
}

export function renameSession(machineId: string, sessionId: string, name: string): boolean {
  if (name.trim() === "") {
    sessionNames.delete(sessionId);
  } else {
    sessionNames.set(sessionId, name.trim());
  }
  saveSessionNames();

  // Apply immediately to current state
  const machine = machines.get(machineId);
  if (!machine) return false;

  const session = machine.sessions.find((s) => s.sessionId === sessionId);
  if (!session) return false;

  session.customName = name.trim() || undefined;
  return true;
}

export function getSavedSessionName(sessionId: string): string | undefined {
  return sessionNames.get(sessionId);
}

export function updateMultiplexerSessionName(machineId: string, sessionId: string, newName: string): void {
  const machine = machines.get(machineId);
  if (!machine) return;
  const session = machine.sessions.find((s) => s.sessionId === sessionId);
  if (session) {
    session.multiplexerSession = newName;
  }
}

export function getSessionSlug(machineId: string, sessionId: string): string | undefined {
  const machine = machines.get(machineId);
  if (!machine) return undefined;
  const session = machine.sessions.find((s) => s.sessionId === sessionId);
  return session?.slug;
}

export function getSessionMultiplexerInfo(
  machineId: string,
  sessionId: string,
): { multiplexer?: string; multiplexerSession?: string } | null {
  const machine = machines.get(machineId);
  if (!machine) return null;
  const session = machine.sessions.find((s) => s.sessionId === sessionId);
  if (!session) return null;
  return {
    multiplexer: session.multiplexer,
    multiplexerSession: session.multiplexerSession,
  };
}

export function getAllMachines(): MachineInfo[] {
  const now = Date.now();
  const result: MachineInfo[] = [];

  // Clean up expired pending sessions
  for (const [key, pending] of pendingSessions) {
    if (now - pending.createdAt > PENDING_SESSION_TIMEOUT_MS) {
      pendingSessions.delete(key);
      log.debug(`pending: expired session=${pending.sessionName}`);
    }
  }

  for (const [id, machine] of machines) {
    const lastSeen = new Date(machine.lastHeartbeat).getTime();
    if (now - lastSeen > MACHINE_TIMEOUT_MS) {
      machines.delete(id);
      continue;
    }

    // Inject pending sessions as "starting" placeholders
    const machinePending = [...pendingSessions.values()].filter((p) => p.machineId === id);
    if (machinePending.length === 0) {
      result.push(machine);
      continue;
    }

    // Filter out pending sessions already covered by real sessions
    const existingMuxNames = new Set(machine.sessions.map((s) => s.multiplexerSession).filter(Boolean));
    const newPending = machinePending.filter((p) => !existingMuxNames.has(p.sessionName));

    if (newPending.length === 0) {
      result.push(machine);
      continue;
    }

    const placeholders = newPending.map((p) => ({
      sessionId: `pending-${p.sessionName}`,
      slug: p.sessionName,
      customName: p.sessionName,
      projectPath: p.projectDir,
      projectName: basename(p.projectDir),
      gitBranch: "",
      status: "starting" as const,
      lastActivity: new Date(p.createdAt).toISOString(),
      lastMessage: "New session — connect to the terminal to start chatting",
      cwd: p.projectDir,
      multiplexer: p.multiplexer,
      multiplexerSession: p.sessionName,
    }));

    result.push({
      ...machine,
      sessions: [...placeholders, ...machine.sessions],
    });
  }

  return result;
}

export function getMachine(machineId: string): MachineInfo | undefined {
  return machines.get(machineId);
}

// Settings store
const SETTINGS_FILE = join(SESSION_NAMES_DIR, "settings.json");

let settings: Settings = {
  defaultMultiplexer: "zellij",
  defaultAgentType: "claude-code",
  zellijLayout: "agent",
  autoDeleteOnClose: false,
  defaultProjectDir: "",
  fontSize: "small",
  theme: "dark",
};

function loadSettings(): void {
  try {
    const data = readFileSync(SETTINGS_FILE, "utf-8");
    const parsed = JSON.parse(data) as Partial<Settings>;
    settings = { ...settings, ...parsed };
    log.info(`loaded settings from ${SETTINGS_FILE}`);
  } catch (err) {
    log.debug(`settings file not loaded (using defaults): ${err instanceof Error ? err.message : String(err)}`);
  }
}

function saveSettings(): void {
  try {
    mkdirSync(SESSION_NAMES_DIR, { recursive: true });
    writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2));
  } catch (err) {
    log.warn(`failed to save settings: ${err instanceof Error ? err.message : String(err)}`);
  }
}

loadSettings();

export function getSettings(): Settings {
  return { ...settings };
}

export function updateSettings(patch: Partial<Settings>): Settings {
  settings = { ...settings, ...patch };
  saveSettings();
  return { ...settings };
}

// --- Remote nodes store ---

const NODES_FILE = join(SESSION_NAMES_DIR, "nodes.json");
const nodes = new Map<string, RemoteNode>();

function loadNodes(): void {
  try {
    const data = readFileSync(NODES_FILE, "utf-8");
    const parsed = JSON.parse(data) as RemoteNode[];
    for (const node of parsed) {
      // Reset runtime status on load — actual status is set by SSH manager
      node.status = "disconnected";
      node.error = undefined;
      nodes.set(node.id, node);
    }
    log.info(`loaded ${nodes.size} remote node(s) from ${NODES_FILE}`);
  } catch (err) {
    log.debug(`nodes file not loaded: ${err instanceof Error ? err.message : String(err)}`);
  }
}

function saveNodes(): void {
  try {
    mkdirSync(SESSION_NAMES_DIR, { recursive: true });
    const arr = [...nodes.values()];
    writeFileSync(NODES_FILE, JSON.stringify(arr, null, 2));
  } catch (err) {
    log.warn(`failed to save nodes: ${err instanceof Error ? err.message : String(err)}`);
  }
}

loadNodes();

export function getAllNodes(): RemoteNode[] {
  return [...nodes.values()];
}

export function getNode(id: string): RemoteNode | undefined {
  return nodes.get(id);
}

export function createNode(req: CreateNodeRequest): RemoteNode {
  const node: RemoteNode = {
    id: randomUUID(),
    name: req.name,
    host: req.host,
    port: req.port ?? 22,
    user: req.user,
    sshKeyPath: req.sshKeyPath,
    agentPort: req.agentPort ?? 4681,
    status: "disconnected",
    autoConnect: req.autoConnect ?? false,
    enableHooks: req.enableHooks ?? true,
  };
  nodes.set(node.id, node);
  saveNodes();
  log.info(`created node: name=${node.name} host=${node.host} id=${node.id.slice(0, 8)}`);
  return node;
}

export function updateNode(id: string, patch: UpdateNodeRequest): RemoteNode | null {
  const node = nodes.get(id);
  if (!node) return null;

  if (patch.name !== undefined) node.name = patch.name;
  if (patch.host !== undefined) node.host = patch.host;
  if (patch.port !== undefined) node.port = patch.port;
  if (patch.user !== undefined) node.user = patch.user;
  if (patch.sshKeyPath !== undefined) node.sshKeyPath = patch.sshKeyPath;
  if (patch.agentPort !== undefined) node.agentPort = patch.agentPort;
  if (patch.autoConnect !== undefined) node.autoConnect = patch.autoConnect;
  if (patch.enableHooks !== undefined) node.enableHooks = patch.enableHooks;

  saveNodes();
  return node;
}

export function deleteNode(id: string): boolean {
  const node = nodes.get(id);
  const existed = nodes.delete(id);
  if (existed) {
    saveNodes();
    log.info(`deleted node: name=${node?.name || "?"} id=${id.slice(0, 8)}`);
  }
  return existed;
}

export function updateNodeStatus(id: string, status: NodeStatus, error?: string): void {
  const node = nodes.get(id);
  if (!node) return;
  const prevStatus = node.status;
  node.status = status;
  node.error = error;
  if (status === "connected") {
    node.lastConnected = new Date().toISOString();
  }
  log.debug(`node status: name=${node.name} ${prevStatus} -> ${status}${error ? ` error="${error}"` : ""}`);
}
