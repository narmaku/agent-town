import { statSync } from "node:fs";
import { resolve } from "node:path";

import { createLogger, type RemoteNode } from "@agent-town/shared";
import type { Subprocess } from "bun";
import { updateNodeStatus } from "./store";

const log = createLogger("ssh");

// Active SSH tunnel processes: nodeId → { tunnel, monitor }
interface NodeConnection {
  // SSH tunnel: forward local port → remote agent port, reverse remote → local server
  tunnel: Subprocess;
  localPort: number;
  // Periodic health check
  monitorTimer: ReturnType<typeof setInterval>;
}

const connections = new Map<string, NodeConnection>();

// Maps remote machine hostname → local forwarded port.
// Populated when the remote agent heartbeats through the tunnel.
// Used by the server to route API calls through the tunnel instead of
// directly to localhost:agentPort (which would hit the local agent).
const hostToTunnelPort = new Map<string, number>();

// Port range for local forwarding (one per node)
let nextLocalPort = 14680;

const HEALTH_CHECK_INTERVAL_MS = 15_000;

export function resolveHome(filePath: string): string {
  if (filePath.startsWith("~/")) {
    return filePath.replace("~", process.env.HOME || "/root");
  }
  return filePath;
}

/** Validate that an SSH key path points to an accessible regular file. */
export function validateSshKeyPath(keyPath: string): string | null {
  const resolved = resolve(resolveHome(keyPath));
  try {
    const stats = statSync(resolved);
    if (!stats.isFile()) return `SSH key path is not a regular file: ${keyPath}`;
    const mode = stats.mode & 0o777;
    if ((mode & 0o077) !== 0) {
      log.warn(`SSH key has permissive permissions (${mode.toString(8)}): ${keyPath}`);
    }
    return null;
  } catch (err) {
    log.warn("SSH key validation failed", { keyPath, error: String(err) });
    return `SSH key not accessible: ${keyPath}`;
  }
}

function buildSshOpts(node: { sshKeyPath: string; port: number }, extra?: string[]): string[] {
  return [
    "-i",
    resolveHome(node.sshKeyPath),
    "-p",
    String(node.port),
    "-o",
    "StrictHostKeyChecking=accept-new",
    "-o",
    "ConnectTimeout=10",
    ...(extra || []),
  ];
}
const DEPLOY_SCRIPT = `
set -e
AGENT_DIR="$HOME/.agent-town-remote"
BUN_DIR="$HOME/.bun"

# Ensure bun is available
if ! command -v bun &>/dev/null && [ ! -x "$BUN_DIR/bin/bun" ]; then
  echo "DEPLOY: installing bun..."
  curl -fsSL https://bun.sh/install | bash 2>&1
fi
export PATH="$BUN_DIR/bin:$HOME/.local/bin:$PATH"

cd "$AGENT_DIR"

# Install dependencies
echo "DEPLOY: installing dependencies..."
bun install 2>&1

echo "DEPLOY: done"
`;

/**
 * Deploy agent code to a remote node via rsync + SSH.
 * Non-invasive: no sudo, no system packages. Installs bun to ~/.bun if needed.
 */
async function deployAgent(node: RemoteNode): Promise<void> {
  const sshTarget = `${node.user}@${node.host}`;
  const sshOpts = buildSshOpts(node);

  log.info(`deploy: syncing agent code to ${sshTarget}...`);

  // Phase 1: Ensure remote directory exists
  log.info(`deploy: [${node.name}] phase 1/4 — creating remote directory on ${sshTarget}`);
  const mkdirProc = Bun.spawn(["ssh", ...sshOpts, sshTarget, "mkdir -p ~/.agent-town-remote"], {
    stdout: "pipe",
    stderr: "pipe",
  });
  await mkdirProc.exited;
  if (mkdirProc.exitCode !== 0) {
    const stderr = await new Response(mkdirProc.stderr).text();
    throw new Error(`SSH mkdir failed: ${stderr.trim()}`);
  }

  // Phase 2: Rsync agent + shared workspace packages to remote
  log.info(`deploy: [${node.name}] phase 2/4 — syncing source code via rsync`);
  const projectRoot = new URL("../../", import.meta.url).pathname;
  for (const dir of ["agent", "shared"]) {
    const syncDir = Bun.spawn(
      [
        "rsync",
        "-az",
        "--delete",
        "--exclude=node_modules",
        "--exclude=.git",
        "-e",
        `ssh ${sshOpts.join(" ")}`,
        `${projectRoot}${dir}/`,
        `${sshTarget}:~/.agent-town-remote/${dir}/`,
      ],
      { stdout: "pipe", stderr: "pipe" },
    );
    await syncDir.exited;
    if (syncDir.exitCode !== 0) {
      const stderr = await new Response(syncDir.stderr).text();
      throw new Error(`rsync ${dir}/ failed: ${stderr.trim()}`);
    }
    log.debug(`deploy: [${node.name}] rsync ${dir}/ completed`);
  }

  // Phase 3: Generate a minimal package.json for the remote — only agent + shared workspaces.
  // The root package.json references all 4 workspaces (server, dashboard too),
  // which don't exist on the remote and cause bun install to fail.
  const remotePackageJson = JSON.stringify(
    {
      name: "agent-town-remote",
      private: true,
      workspaces: ["shared", "agent"],
    },
    null,
    2,
  );

  const writePackageJson = Bun.spawn(["ssh", ...sshOpts, sshTarget, `cat > ~/.agent-town-remote/package.json`], {
    stdin: new TextEncoder().encode(remotePackageJson),
    stdout: "pipe",
    stderr: "pipe",
  });
  await writePackageJson.exited;

  // Phase 4: Run deploy script (install bun + dependencies)
  log.info(`deploy: [${node.name}] phase 4/4 — running setup script on ${sshTarget}`);

  // Run deploy script — use --norc --noprofile to avoid sourcing user shell
  // config (which may reference tools not in PATH, e.g. brew on some systems)
  const deployProc = Bun.spawn(["ssh", ...sshOpts, sshTarget, "bash --norc --noprofile -s"], {
    stdin: new TextEncoder().encode(DEPLOY_SCRIPT),
    stdout: "pipe",
    stderr: "pipe",
  });
  const deployOut = await new Response(deployProc.stdout).text();
  await deployProc.exited;

  if (deployProc.exitCode !== 0) {
    const stderr = await new Response(deployProc.stderr).text();
    throw new Error(`Deploy script failed: ${stderr.trim()}`);
  }

  for (const line of deployOut.trim().split("\n")) {
    if (line.startsWith("DEPLOY:")) log.info(`deploy: ${sshTarget} ${line}`);
  }
}

/**
 * Configure Claude Code hooks on a remote node.
 * Merges hook config into ~/.claude/settings.json without overwriting
 * other settings. Hooks point to the local agent (localhost:agentPort).
 */
async function configureHooks(node: RemoteNode): Promise<void> {
  const sshTarget = `${node.user}@${node.host}`;
  const sshOpts = buildSshOpts(node);
  const hookUrl = `http://localhost:${node.agentPort}/api/hook-event`;

  log.info(`hooks: configuring Claude Code hooks on ${sshTarget} → ${hookUrl}`);

  // Build the hook config
  const hookEntry = [
    {
      matcher: "",
      hooks: [{ type: "command", command: `curl -s -X POST ${hookUrl} -H 'Content-Type: application/json' -d @-` }],
    },
  ];
  const hooksConfig = {
    PreToolUse: hookEntry,
    PostToolUse: hookEntry,
    Notification: hookEntry,
    Stop: hookEntry,
    UserPromptSubmit: hookEntry,
    SessionStart: hookEntry,
    SessionEnd: hookEntry,
  };

  // Read existing settings, merge hooks, write back
  const script = `
import json, os
path = os.path.expanduser("~/.claude/settings.json")
try:
    with open(path) as f:
        settings = json.load(f)
except:
    settings = {}
settings["hooks"] = json.loads('${JSON.stringify(hooksConfig)}')
os.makedirs(os.path.dirname(path), exist_ok=True)
with open(path, "w") as f:
    json.dump(settings, f, indent=2)
print("HOOKS: configured")
`;

  const proc = Bun.spawn(["ssh", ...sshOpts, sshTarget, "python3 -c " + JSON.stringify(script)], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const output = await new Response(proc.stdout).text();
  await proc.exited;

  if (proc.exitCode !== 0) {
    const stderr = await new Response(proc.stderr).text();
    log.warn(`hooks: failed to configure on ${sshTarget}: ${stderr.trim()}`);
  } else {
    log.info(`hooks: ${output.trim()}`);
  }
}

/**
 * Start the agent on a remote node via SSH, then set up tunnels.
 *
 * Tunnel setup:
 * - Forward tunnel: localPort → remote agentPort (so server can reach agent API)
 * - Reverse tunnel: remote 4680 → local 4680 (so agent can heartbeat to server)
 */
async function startTunnels(node: RemoteNode, serverPort: number): Promise<NodeConnection> {
  const localPort = nextLocalPort++;
  const sshTarget = `${node.user}@${node.host}`;

  log.info(
    `tunnel: ${node.name} — local:${localPort} → remote:${node.agentPort}, reverse remote:${serverPort} → local:${serverPort}`,
  );

  const sshOpts = buildSshOpts(node, [
    "-o",
    "ServerAliveInterval=15",
    "-o",
    "ServerAliveCountMax=3",
    "-o",
    "ExitOnForwardFailure=yes",
  ]);

  // Start agent on remote via base64-encoded script.
  // This avoids all shell quoting issues — the script is decoded and piped to bash.
  const startScript = [
    "#!/bin/bash",
    'export PATH="$HOME/.bun/bin:$HOME/.cargo/bin:$HOME/.local/bin:$PATH"',
    "mkdir -p ~/.agent-town",
    'pkill -f "bun.*agent/src/index" 2>/dev/null || true',
    "sleep 1",
    "cd ~/.agent-town-remote",
    `export AGENT_TOWN_SERVER="http://localhost:${serverPort}"`,
    `export AGENT_TOWN_TERMINAL_PORT=${node.agentPort}`,
    "nohup bun run agent/src/index.ts >> ~/.agent-town/agent.log 2>&1 &",
    'echo "AGENT_PID=$!"',
  ].join("\n");

  const b64 = Buffer.from(startScript).toString("base64");
  const startProc = Bun.spawn(["ssh", ...sshOpts, sshTarget, `echo ${b64} | base64 -d | bash --norc --noprofile`], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const startOut = await new Response(startProc.stdout).text();
  await startProc.exited;
  log.info(`tunnel: remote agent start: ${startOut.trim() || "(no output)"} exit=${startProc.exitCode}`);

  // Set up SSH tunnel (forward + reverse)
  const tunnel = Bun.spawn(
    [
      "ssh",
      ...sshOpts,
      "-N", // no remote command
      "-L",
      `${localPort}:localhost:${node.agentPort}`, // forward: local → remote agent
      "-R",
      `${serverPort}:localhost:${serverPort}`, // reverse: remote → local server
      sshTarget,
    ],
    { stdout: "pipe", stderr: "pipe" },
  );

  // Read stderr for errors
  (async () => {
    const reader = tunnel.stderr.getReader();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const text = new TextDecoder().decode(value).trim();
        if (text) log.debug(`tunnel: ${node.name} stderr: ${text}`);
      }
    } catch (err) {
      log.debug(`tunnel: ${node.name} stderr reader ended: ${err instanceof Error ? err.message : String(err)}`);
    }
  })();

  // Monitor tunnel health
  const monitorTimer = setInterval(async () => {
    try {
      const resp = await fetch(`http://localhost:${localPort}/`, { signal: AbortSignal.timeout(5000) });
      if (resp.ok) {
        log.debug(`health: [${node.name}] tunnel healthy (localhost:${localPort})`);
        if (node.status !== "connected") {
          log.info(`health: [${node.name}] tunnel recovered — marking connected`);
          updateNodeStatus(node.id, "connected");
        }
      } else {
        log.warn(`health: [${node.name}] tunnel returned status ${resp.status}`);
      }
    } catch (err) {
      // Check if tunnel process is still alive
      if (tunnel.exitCode !== null) {
        log.warn(`health: [${node.name}] SSH tunnel exited (code ${tunnel.exitCode}), reconnecting...`);
        clearInterval(monitorTimer);
        connections.delete(node.id);
        updateNodeStatus(node.id, "error", "SSH tunnel disconnected");
        // Auto-reconnect after a delay
        setTimeout(() => connectNode(node.id), 5000);
      } else {
        log.debug(
          `health: [${node.name}] check failed (tunnel alive): ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  }, HEALTH_CHECK_INTERVAL_MS);

  return { tunnel, localPort, monitorTimer };
}

/**
 * Connect to a remote node: deploy agent, start tunnels.
 */
export async function connectNode(nodeId: string): Promise<void> {
  // Import dynamically to avoid circular dependency
  const { getNode } = await import("./store");
  const node = getNode(nodeId);
  if (!node) throw new Error(`Node ${nodeId} not found`);

  // Disconnect existing connection if any
  if (connections.has(nodeId)) {
    await disconnectNode(nodeId);
  }

  try {
    // Validate SSH key before attempting connection
    const keyError = validateSshKeyPath(node.sshKeyPath);
    if (keyError) {
      log.error(`connect: [${node.name}] SSH key validation failed: ${keyError}`);
      updateNodeStatus(nodeId, "error", keyError);
      throw new Error(keyError);
    }

    updateNodeStatus(nodeId, "connecting");
    log.info(`connect: [${node.name}] starting connection to ${node.user}@${node.host}:${node.port}`);

    // Phase 1: Test SSH connectivity
    log.info(`connect: [${node.name}] phase 1/3 — testing SSH connectivity`);
    const testProc = Bun.spawn(
      ["ssh", ...buildSshOpts(node, ["-o", "BatchMode=yes"]), `${node.user}@${node.host}`, "echo ok"],
      { stdout: "pipe", stderr: "pipe" },
    );
    const testOut = await new Response(testProc.stdout).text();
    await testProc.exited;

    if (testProc.exitCode !== 0 || testOut.trim() !== "ok") {
      const stderr = await new Response(testProc.stderr).text();
      throw new Error(`SSH connection failed: ${stderr.trim() || "unknown error"}`);
    }

    log.info(`connect: [${node.name}] SSH connectivity verified`);

    // Phase 2: Deploy agent code + configure hooks
    log.info(`connect: [${node.name}] phase 2/3 — deploying agent code`);
    updateNodeStatus(nodeId, "deploying");
    await deployAgent(node);

    if (node.enableHooks) {
      await configureHooks(node);
    }

    // Phase 3: Start tunnels
    log.info(`connect: [${node.name}] phase 3/3 — starting SSH tunnels`);
    const serverPort = Number(process.env.AGENT_TOWN_PORT || "4680");
    const conn = await startTunnels(node, serverPort);
    connections.set(nodeId, conn);

    // Get the remote machine's hostname so we can route API calls through the tunnel
    const hostnameProc = Bun.spawn(
      ["ssh", ...buildSshOpts(node, ["-o", "BatchMode=yes"]), `${node.user}@${node.host}`, "hostname"],
      { stdout: "pipe", stderr: "pipe" },
    );
    const remoteHostname = (await new Response(hostnameProc.stdout).text()).trim();
    await hostnameProc.exited;
    if (remoteHostname) {
      hostToTunnelPort.set(remoteHostname, conn.localPort);
      log.info(`connect: mapped hostname "${remoteHostname}" → localhost:${conn.localPort}`);
    }

    updateNodeStatus(nodeId, "connected");
    log.info(`connect: ${node.name} — connected (local port ${conn.localPort})`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error(`connect: ${node.name} — failed: ${message}`);
    updateNodeStatus(nodeId, "error", message);
    throw err;
  }
}

/**
 * Disconnect from a remote node: kill tunnels, clean up.
 */
export async function disconnectNode(nodeId: string): Promise<void> {
  const conn = connections.get(nodeId);
  if (!conn) return;

  clearInterval(conn.monitorTimer);
  conn.tunnel.kill();
  connections.delete(nodeId);
  updateNodeStatus(nodeId, "disconnected");

  const { getNode } = await import("./store");
  const node = getNode(nodeId);
  log.info(`disconnect: ${node?.name || nodeId}`);
}

/**
 * Test SSH connectivity to a node without connecting.
 */
export async function testNodeConnection(node: {
  host: string;
  port: number;
  user: string;
  sshKeyPath: string;
}): Promise<{ ok: boolean; error?: string; remoteInfo?: string }> {
  log.info(`test: SSH connection to ${node.user}@${node.host}:${node.port}`);

  // Validate SSH key before attempting connection
  const keyError = validateSshKeyPath(node.sshKeyPath);
  if (keyError) {
    log.warn(`test: SSH key validation failed for ${node.user}@${node.host}: ${keyError}`);
    return { ok: false, error: keyError };
  }

  try {
    const testProc = Bun.spawn(
      [
        "ssh",
        ...buildSshOpts(node, ["-o", "BatchMode=yes"]),
        `${node.user}@${node.host}`,
        "hostname && uname -s && whoami",
      ],
      { stdout: "pipe", stderr: "pipe" },
    );
    const stdout = await new Response(testProc.stdout).text();
    await testProc.exited;

    if (testProc.exitCode !== 0) {
      const stderr = await new Response(testProc.stderr).text();
      log.warn(`test: SSH connection to ${node.user}@${node.host} failed: ${stderr.trim() || "unknown error"}`);
      return { ok: false, error: stderr.trim() || "Connection failed" };
    }

    log.info(`test: SSH connection to ${node.user}@${node.host} succeeded: ${stdout.trim()}`);
    return { ok: true, remoteInfo: stdout.trim() };
  } catch (err) {
    log.error(
      `test: SSH connection to ${node.user}@${node.host} error: ${err instanceof Error ? err.message : String(err)}`,
    );
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Get the local forwarded port for a connected node.
 * Used by the server to proxy API calls to the remote agent.
 */
export function getNodeLocalPort(nodeId: string): number | undefined {
  return connections.get(nodeId)?.localPort;
}

/**
 * Resolve the correct agent address and port for a machine.
 * If the machine is a remote node connected via SSH tunnel, returns
 * localhost + the tunnel's forwarded port. Otherwise returns null
 * (meaning use the machine's own agentAddress + terminalPort).
 */
export function resolveAgentEndpoint(machineHostname: string): { host: string; port: number } | null {
  const tunnelPort = hostToTunnelPort.get(machineHostname);
  if (tunnelPort) return { host: "localhost", port: tunnelPort };
  return null;
}

/**
 * Connect all nodes marked with autoConnect on server startup.
 */
export async function connectAutoNodes(): Promise<void> {
  const { getAllNodes } = await import("./store");
  const autoNodes = getAllNodes().filter((n) => n.autoConnect);
  if (autoNodes.length === 0) return;

  log.info(`auto-connect: ${autoNodes.length} node(s)`);
  for (const node of autoNodes) {
    connectNode(node.id).catch((err) => {
      log.error(`auto-connect: ${node.name} failed: ${err instanceof Error ? err.message : String(err)}`);
    });
  }
}
