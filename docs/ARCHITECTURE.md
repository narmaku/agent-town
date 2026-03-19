# Agent Town Architecture

This document describes the internal architecture, data flows, and key subsystems of Agent Town.

---

## High-Level Architecture

```
+-------------------+         WebSocket + HTTP          +-------------------+
|                   | <-------------------------------> |                   |
|  Browser (React)  |   ws://server/ws (state updates)  |  Server (:4680)   |
|  Dashboard SPA    |   ws://server/ws/terminal (PTY)   |  Bun HTTP/WS      |
|                   |   HTTP /api/* (REST)               |                   |
+-------------------+                                   +--------+----------+
                                                                 |
                                              HTTP heartbeats    |  HTTP proxy
                                              every 5s           |  to agents
                                                                 |
                                +--------------------------------+----------------+
                                |                                                 |
                        +-------v--------+                               +--------v-------+
                        |                |  SSH tunnel (forward+reverse) |                |
                        |  Agent (:4681) | <---------------------------> |  Agent (:4681) |
                        |  Local machine |                               |  Remote node   |
                        |                |                               |                |
                        +-------+--------+                               +--------+-------+
                                |                                                 |
                    +-----------+-----------+                         +-----------+-----------+
                    |           |           |                         |           |           |
                 zellij      tmux      processes                  zellij      tmux      processes
                 sessions    sessions   (ps)                      sessions    sessions   (ps)
                    |           |           |                         |           |           |
                 claude      opencode   process                   claude      opencode   process
                 code                   mapper                    code                   mapper
```

### Components

**Dashboard** (`dashboard/`): A React 19 SPA built with Vite. Connects to the server via WebSocket for real-time state updates. Provides terminal access via xterm.js. Served as static files by the server.

**Server** (`server/`): Central hub running on port 4680. Receives heartbeats from agents, stores machine/session state in memory, broadcasts updates to dashboard clients, proxies API calls and terminal connections to agents. Manages SSH tunnels for remote nodes.

**Agent** (`agent/`): Runs on each machine (local or remote) on port 4681. Discovers AI coding agent sessions through the provider plugin system, maps running processes to multiplexer sessions, sends heartbeats to the server, and provides terminal relay and session management APIs.

**Shared** (`shared/`): TypeScript type definitions and the logger utility. No runtime dependencies. Used by both server and agent.

---

## Session Discovery Lifecycle

Every heartbeat interval (default: 5 seconds), the agent performs four parallel operations:

```
discoverSessions()        detectMultiplexers()      listAllSessions()       discoverProcessMappings()
       |                        |                         |                         |
       v                        v                         v                         v
  SessionInfo[]            ["zellij","tmux"]     MultiplexerSessionInfo[]    Map<string, ProcessMapping>
  (from providers)         (which binaries)      (all mux sessions)         (pid -> mux session)
```

### Step 1: Discover Sessions (session-parser.ts)

Calls `discoverSessions()` on all registered providers in parallel. Each provider reads its native storage:

- **Claude Code:** Scans `~/.claude/projects/*/` for JSONL files. Parses the first and last few lines of each file to extract session metadata (ID, project path, status, last message, model).
- **OpenCode:** Calls `session.list()` via the SDK (or reads SQLite at `~/.opencode/data.db` as fallback).

Returns a flat array of `SessionInfo[]` -- at this point, no multiplexer mapping exists.

### Step 2: Detect Multiplexers (multiplexer.ts)

Runs `which zellij` and `which tmux` to detect available multiplexer binaries.

### Step 3: List Multiplexer Sessions (multiplexer.ts)

Runs `zellij list-sessions --short` and `tmux list-sessions -F "#{session_name}:#{session_attached}"` to enumerate all multiplexer sessions. Returns `MultiplexerSessionInfo[]` with name, type, and attached status.

### Step 4: Discover Process Mappings (process-mapper.ts)

This is the core mapping logic that connects agent sessions to multiplexer sessions:

1. Runs `ps -eo pid,ppid,etimes,args` to get all system processes.
2. Filters through each provider's `filterAgentProcesses()` to find agent processes.
3. For each agent process:
   a. Reads `/proc/<ppid>/environ` to find `ZELLIJ_SESSION_NAME` or `TMUX` environment variables.
   b. If found, maps the process to that multiplexer session.
   c. Extracts the agent session ID from command-line args (`extractSessionIdFromArgs`).
   d. If no session ID in args, falls back to `matchProcessToSessionId()` which uses provider-specific heuristics (JSONL birth time matching, directory matching).

Returns `Map<string, ProcessMapping>` keyed by session ID (or `cwd:<path>` for unmatched processes).

### Step 5: Merge and Adjust

After parallel discovery completes, the agent merges the results:

1. **Apply process mappings** to sessions: sets `multiplexer` and `multiplexerSession` fields.
2. **Validate mappings** against active multiplexer sessions -- rejects mappings to non-existent sessions (zombie process protection).
3. **Adjust statuses** using priority: hook events > process mapper > storage heuristics.
4. **Detect exited sessions** by comparing current mappings against historical tracking (`lastKnownMux`).
5. **Create placeholder sessions** for agent processes that have no JSONL yet (freshly launched).

---

## Process-to-Multiplexer Mapping

The mapping relies on Linux `/proc` filesystem to inspect process environment variables:

```
Agent process (PID 12345)
  |
  +-- Parent shell (PPID 12340)
       |
       +-- /proc/12340/environ
            Contains: ZELLIJ_SESSION_NAME=my-project
            Or: TMUX=/tmp/tmux-1000/default,12,0
```

For zellij, the session name is directly available in `ZELLIJ_SESSION_NAME`.

For tmux, the session name requires additional resolution: read the process's controlling TTY from `/proc/<pid>/fd/0`, then cross-reference with `tmux list-panes -a -F "#{pane_tty}:#{session_name}"`.

**Rename tracking:** When a multiplexer session is renamed via the dashboard, the shell process retains the old `ZELLIJ_SESSION_NAME` value. A rename map (`~/.agent-town/rename-map.json`) tracks old-to-new name mappings so the process mapper resolves stale names correctly.

---

## Real-Time Status Updates

Agent Town uses two complementary mechanisms for real-time session status:

### Hook Events (Claude Code)

Claude Code supports configurable hooks that fire on session lifecycle events. Agent Town configures these hooks (in `~/.claude/settings.json`) to POST event data to the agent's `/api/hook-event` endpoint:

```
Claude Code process
  |  hook fires (PreToolUse, Stop, etc.)
  v
curl -X POST http://localhost:4681/api/hook-event
  |
  v
Agent hook-store (in-memory, per session)
  |  next heartbeat includes hook-derived status
  v
Server broadcasts to dashboard
```

Hook events supported:
| Event              | Mapped Status       |
|--------------------|---------------------|
| `UserPromptSubmit` | `working`           |
| `PreToolUse`       | `working` + tool    |
| `PostToolUse`      | `working`           |
| `Stop`             | `awaiting_input`    |
| `Notification`     | `action_required` or `awaiting_input` |
| `SessionStart`     | `awaiting_input`    |
| `SessionEnd`       | `done`              |

### SSE Events (OpenCode)

The OpenCode provider subscribes to Server-Sent Events (SSE) via the OpenCode SDK for real-time status:

```
OpenCode server (port 4096)
  |  SSE stream (event.subscribe)
  v
Agent OpenCode provider
  |  maps to HookEventResult
  v
Agent hook-store
  |  next heartbeat includes SSE-derived status
  v
Server broadcasts to dashboard
```

SSE events mapped:
| Event Type              | Mapped Status     |
|-------------------------|-------------------|
| `session.status` (busy) | `working`         |
| `session.status` (idle) | `awaiting_input`  |
| `session.created`       | `awaiting_input`  |
| `session.deleted`       | `done`            |
| `session.error`         | `error`           |
| `message.part.updated`  | `working`         |
| `permission.updated`    | `action_required` |

### Status Priority

When building the heartbeat, statuses are resolved with this priority (highest first):

1. **Hook/SSE events** -- Most accurate. If a hook state exists and is not stale (>60s for `working` status), it overrides everything.
2. **Process mapper** -- If an agent process has active child processes (within 600s), status is set to `working`. If no active children, set to `awaiting_input`.
3. **Storage heuristics** -- Base status derived from JSONL file modification times or SDK responses. Least accurate.

---

## Heartbeat Protocol

The agent sends HTTP POST requests to `{SERVER_URL}/api/heartbeat` every 5 seconds (configurable via `AGENT_TOWN_INTERVAL`).

### Heartbeat Payload

```typescript
interface Heartbeat {
  machineId: string;         // Stable hash of hostname (or AGENT_TOWN_MACHINE_ID)
  hostname: string;          // OS hostname
  platform: string;          // OS platform (linux, darwin)
  sessions: SessionInfo[];   // All discovered sessions with status
  multiplexers: TerminalMultiplexer[];       // Available multiplexer binaries
  multiplexerSessions: MultiplexerSessionInfo[]; // Active (non-exited) mux sessions
  terminalPort: number;      // Agent's terminal server port
  timestamp: string;         // ISO timestamp
}
```

### Server Processing

When the server receives a heartbeat:

1. **Deduplication:** If another machine with the same hostname exists under a different ID, the old entry is removed (handles agent restarts).
2. **Name application:** Custom session names from the persistent store are applied. Multiplexer session names are auto-persisted for new sessions.
3. **Pending session cleanup:** Any pending sessions (from recent launches) that now appear in the heartbeat are removed.
4. **State update:** The machine entry is upserted in the in-memory store.
5. **Broadcast:** A `machines_update` WebSocket message is sent to all connected dashboard clients.

### Machine Timeout

Machines are considered offline and removed from state after 30 seconds without a heartbeat (`MACHINE_TIMEOUT_MS`).

---

## Terminal Relay Architecture

Terminal access from the browser flows through two WebSocket connections with a PTY helper process:

```
Browser (xterm.js)
  |  ws://server:4680/ws/terminal?machineId=X&session=Y
  v
Server WebSocket proxy
  |  ws://agent:4681/ws/terminal?session=Y
  v
Agent Terminal Server
  |  spawns PTY helper
  v
python3 pty-helper.py <cols> <rows> <multiplexer-attach-command>
  |  forks a pseudo-terminal
  v
zellij attach <session> / tmux attach-session -t <session>
```

### PTY Helper

The agent uses a Python PTY helper (`agent/src/pty-helper.py`) to create a proper pseudo-terminal for the multiplexer attach command. This is necessary because multiplexers require a TTY to attach.

The PTY helper:
- Creates a pseudo-terminal with the specified dimensions
- Spawns the attach command inside it
- Forwards stdin/stdout over pipes
- Handles terminal resize events (received as JSON on stdin)

### Data Flow

1. **Browser to agent:** Keyboard input is sent as WebSocket text/binary messages. The server proxy forwards them verbatim to the agent. The agent writes them to the PTY helper's stdin.

2. **Agent to browser:** Terminal output from the PTY helper's stdout is read and sent as binary WebSocket messages. The server proxy forwards them to the browser.

3. **Resize:** The browser sends a JSON message `{"type":"resize","cols":N,"rows":N}`. The agent forwards this to the PTY helper, which adjusts the terminal size.

### Cgroup Isolation

When launched multiplexer sessions are created by the agent, they are wrapped in `systemd-run --scope` to run in a separate cgroup. This prevents `systemctl restart agent-town` from killing all the multiplexer sessions (and the AI agents inside them). Falls back to direct spawn on systems without systemd (e.g., macOS).

---

## State Management

### Server State (store.ts)

All state is held in memory with JSON file persistence for specific data:

| Data               | Storage                              | Persistence |
|--------------------|--------------------------------------|-------------|
| Machine info       | In-memory `Map<string, MachineInfo>` | None -- rebuilt from heartbeats |
| Session names      | `~/.agent-town/session-names.json`   | Survives restarts |
| Settings           | `~/.agent-town/settings.json`        | Survives restarts |
| Remote nodes       | `~/.agent-town/nodes.json`           | Survives restarts (status reset to `disconnected`) |
| Pending sessions   | In-memory `Map`                      | None -- expires after 60s |

### Agent State

| Data               | Storage                              | Persistence |
|--------------------|--------------------------------------|-------------|
| Hook states        | In-memory `Map` (hook-store.ts)      | None |
| Last-known mux     | `~/.agent-town/last-known-mux.json`  | Survives restarts |
| Rename mappings    | `~/.agent-town/rename-map.json`      | Survives restarts |
| Session names      | `~/.agent-town/session-names.json`   | Survives restarts |

---

## Multi-Machine Setup with SSH Tunnels

The server manages SSH connections to remote nodes for multi-machine monitoring:

```
Server machine (port 4680)
  |
  +-- SSH tunnel to remote-1
  |     Forward: localhost:14680 --> remote-1:4681  (server reaches agent)
  |     Reverse: remote-1:4680  --> localhost:4680  (agent reaches server)
  |
  +-- SSH tunnel to remote-2
        Forward: localhost:14681 --> remote-2:4681
        Reverse: remote-2:4680  --> localhost:4680
```

### Connection Process

1. **Test SSH connectivity** -- Runs `ssh echo ok` to verify access.
2. **Deploy agent code** -- Uses `rsync` to sync `agent/` and `shared/` directories to `~/.agent-town-remote/` on the remote.
3. **Install dependencies** -- Runs `bun install` on the remote (installs bun first if needed).
4. **Configure hooks** -- If `enableHooks` is set, merges Claude Code hook config into remote `~/.claude/settings.json`.
5. **Start agent** -- Runs the agent process on the remote via `nohup bun run agent/src/index.ts`.
6. **Establish SSH tunnel** -- Sets up forward tunnel (server-to-agent) and reverse tunnel (agent-to-server).
7. **Health monitoring** -- Pings the tunnel every 15 seconds. Auto-reconnects on failure.

### Routing

When the server needs to reach a remote agent (for proxied API calls or terminal connections), it uses `resolveAgentEndpoint()` to check if the machine's hostname maps to a local tunnel port. If so, requests are routed through `localhost:<tunnelPort>` instead of the machine's direct address.
