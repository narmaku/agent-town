# Agent Town API Documentation

This document describes all HTTP endpoints and WebSocket protocols exposed by the Agent Town system. There are two services that expose APIs:

- **Server** (default port `4680`) -- Central hub that the dashboard connects to. Proxies requests to agents.
- **Agent** (default port `4681`) -- Runs on each machine. Manages terminal sessions, session discovery, and hook events.

---

## Server Endpoints (port 4680)

### GET /api/machines

Returns all connected machines with their sessions.

**Response:** `200 OK`
```json
[
  {
    "machineId": "a1b2c3d4e5f6g7h8",
    "hostname": "my-workstation",
    "platform": "linux",
    "lastHeartbeat": "2026-03-18T10:00:00.000Z",
    "sessions": [ ... ],
    "multiplexers": ["zellij", "tmux"],
    "multiplexerSessions": [ ... ],
    "terminalPort": 4681,
    "agentAddress": "localhost"
  }
]
```

**Response type:** `MachineInfo[]`

Machines that have not sent a heartbeat within 30 seconds are automatically removed.

---

### POST /api/heartbeat

Receives heartbeat data from an agent. Updates machine state and broadcasts changes to all connected dashboard WebSocket clients.

**Request body:** `Heartbeat`
```json
{
  "machineId": "a1b2c3d4e5f6g7h8",
  "hostname": "my-workstation",
  "platform": "linux",
  "sessions": [ ... ],
  "multiplexers": ["zellij", "tmux"],
  "multiplexerSessions": [ ... ],
  "terminalPort": 4681,
  "timestamp": "2026-03-18T10:00:00.000Z"
}
```

**Response:** `200 OK`
```json
{ "ok": true }
```

**Error responses:**
- `400` -- Invalid heartbeat payload

---

### GET /api/session-messages

Proxies to the agent to retrieve paginated session messages.

**Query parameters:**
| Parameter   | Required | Default        | Description                      |
|-------------|----------|----------------|----------------------------------|
| `machineId` | Yes      | --             | Machine identifier               |
| `sessionId` | Yes      | --             | Agent session ID                 |
| `agentType` | No       | `"claude-code"` | Agent type (`claude-code` or `opencode`) |
| `offset`    | No       | `0`            | Pagination offset                |
| `limit`     | No       | `10`           | Number of messages to return     |

**Response:** `200 OK` -- `SessionMessagesResponse`
```json
{
  "messages": [
    {
      "role": "user",
      "timestamp": "2026-03-18T10:00:00.000Z",
      "content": "Fix the tests",
      "toolUse": [{ "name": "Edit", "id": "tool_123" }],
      "model": "claude-sonnet-4-20250514"
    }
  ],
  "total": 42,
  "hasMore": true
}
```

**Error responses:**
- `400` -- Missing `machineId` or `sessionId`
- `404` -- Machine not found
- `502` -- Failed to fetch messages from agent

---

### POST /api/sessions/rename

Renames a session in the dashboard. Also renames the associated multiplexer session on the agent if one is active.

**Request body:** `RenameSessionRequest`
```json
{
  "machineId": "a1b2c3d4e5f6g7h8",
  "sessionId": "550e8400-e29b-41d4-a716-446655440000",
  "name": "my-project"
}
```

**Response:** `200 OK`
```json
{ "ok": true }
```

**Error responses:**
- `400` -- Invalid payload
- `404` -- Session not found

---

### POST /api/sessions/kill

Kills (closes) a multiplexer session. Proxied to the agent.

**Request body:**
```json
{
  "machineId": "a1b2c3d4e5f6g7h8",
  "multiplexer": "zellij",
  "session": "my-session"
}
```

**Response:** `200 OK`
```json
{ "ok": true }
```

**Error responses:**
- `404` -- Machine not found
- `502` -- Agent kill failed

---

### POST /api/sessions/delete

Fully deletes a session: kills the multiplexer session, deletes session data (JSONL/DB), and cleans up server state.

**Request body:**
```json
{
  "machineId": "a1b2c3d4e5f6g7h8",
  "sessionId": "550e8400-e29b-41d4-a716-446655440000",
  "multiplexer": "zellij",
  "multiplexerSession": "my-session"
}
```

The `multiplexer` and `multiplexerSession` fields are optional. If omitted, the server looks them up from its stored state.

**Response:** `200 OK`
```json
{ "ok": true }
```

**Error responses:**
- `404` -- Machine not found
- `500` -- Failed to delete session
- `502` -- Agent delete failed

---

### POST /api/sessions/send

Sends text to a session's multiplexer (like typing into the terminal). Proxied to the agent.

**Request body:**
```json
{
  "machineId": "a1b2c3d4e5f6g7h8",
  "multiplexer": "zellij",
  "session": "my-session",
  "text": "fix the failing tests",
  "agentType": "claude-code"
}
```

The `agentType` field is optional (defaults to `"claude-code"`). It affects how text is delivered -- OpenCode uses bracketed paste mode for its TUI.

**Response:** `200 OK`
```json
{ "ok": true }
```

**Error responses:**
- `404` -- Machine not found
- `500` -- Failed to send
- `502` -- Agent send failed

---

### POST /api/sessions/reconnect

Reconnects an agent in an existing multiplexer session where the agent has exited but the terminal session is still alive.

**Request body:**
```json
{
  "machineId": "a1b2c3d4e5f6g7h8",
  "multiplexer": "zellij",
  "session": "my-session",
  "sessionId": "550e8400-e29b-41d4-a716-446655440000",
  "agentType": "claude-code"
}
```

**Response:** `200 OK`
```json
{ "ok": true }
```

**Error responses:**
- `404` -- Machine not found
- `500` -- Failed to reconnect
- `502` -- Agent reconnect failed

---

### GET /api/settings

Returns current server settings.

**Response:** `200 OK` -- `Settings`
```json
{
  "defaultMultiplexer": "zellij",
  "defaultAgentType": "claude-code",
  "zellijLayout": "agent",
  "defaultModel": "claude-sonnet-4-20250514",
  "autoDeleteOnClose": false,
  "defaultProjectDir": "",
  "fontSize": "small",
  "theme": "dark"
}
```

---

### POST /api/settings

Updates server settings. Accepts a partial `Settings` object -- only provided fields are updated.

**Request body:** `Partial<Settings>`
```json
{
  "defaultMultiplexer": "tmux",
  "theme": "light"
}
```

**Response:** `200 OK` -- The full updated `Settings` object.

**Error responses:**
- `400` -- Invalid payload

---

### POST /api/agents/launch

Launches a new agent session in a new multiplexer session. Proxied to the agent.

**Request body:** `LaunchAgentRequest`
```json
{
  "machineId": "a1b2c3d4e5f6g7h8",
  "sessionName": "my-project",
  "projectDir": "/home/user/projects/my-project",
  "agentType": "claude-code",
  "autonomous": false,
  "multiplexer": "zellij"
}
```

`agentType`, `autonomous`, and `multiplexer` are optional. Defaults come from server settings.

**Response:** `200 OK`
```json
{
  "ok": true,
  "sessionName": "my-project",
  "multiplexer": "zellij"
}
```

A pending session placeholder is added immediately so the dashboard shows the new session before the next heartbeat.

**Error responses:**
- `404` -- Machine not found
- `500` -- Failed to launch agent
- `502` -- Agent launch failed

---

### POST /api/agents/resume

Resumes an idle session in a new multiplexer session.

**Request body:** `ResumeAgentRequest`
```json
{
  "machineId": "a1b2c3d4e5f6g7h8",
  "sessionId": "550e8400-e29b-41d4-a716-446655440000",
  "projectDir": "/home/user/projects/my-project",
  "agentType": "claude-code",
  "autonomous": false
}
```

`agentType` and `autonomous` are optional.

**Response:** `200 OK`
```json
{
  "ok": true,
  "sessionName": "my-project",
  "multiplexer": "zellij"
}
```

**Error responses:**
- `404` -- Machine not found
- `500` -- Failed to resume agent
- `502` -- Agent resume failed

---

### GET /api/nodes

Returns all configured remote nodes.

**Response:** `200 OK` -- `RemoteNode[]`
```json
[
  {
    "id": "uuid-here",
    "name": "dev-server",
    "host": "192.168.1.100",
    "port": 22,
    "user": "deploy",
    "sshKeyPath": "~/.ssh/id_ed25519",
    "agentPort": 4681,
    "status": "connected",
    "lastConnected": "2026-03-18T10:00:00.000Z",
    "autoConnect": true,
    "enableHooks": true
  }
]
```

---

### POST /api/nodes

Creates a new remote node configuration.

**Request body:** `CreateNodeRequest`
```json
{
  "name": "dev-server",
  "host": "192.168.1.100",
  "port": 22,
  "user": "deploy",
  "sshKeyPath": "~/.ssh/id_ed25519",
  "agentPort": 4681,
  "autoConnect": true,
  "enableHooks": true
}
```

Required fields: `name`, `host`, `user`, `sshKeyPath`. Optional fields default to: `port=22`, `agentPort=4681`, `autoConnect=false`, `enableHooks=true`.

**Response:** `201 Created` -- The created `RemoteNode` object.

**Error responses:**
- `400` -- Missing required fields or invalid payload

---

### PUT /api/nodes/:nodeId

Updates a remote node configuration.

**Request body:** `UpdateNodeRequest` (all fields optional)
```json
{
  "name": "renamed-server",
  "host": "192.168.1.200"
}
```

**Response:** `200 OK` -- The updated `RemoteNode` object.

**Error responses:**
- `400` -- Invalid payload
- `404` -- Node not found

---

### DELETE /api/nodes/:nodeId

Deletes a remote node. Disconnects the SSH tunnel first if connected.

**Response:** `200 OK`
```json
{ "ok": true }
```

**Error responses:**
- `404` -- Node not found

---

### POST /api/nodes/:nodeId/connect

Connects to a remote node. Deploys the agent code via rsync, starts the agent process, and sets up SSH tunnels (forward + reverse). Runs asynchronously in the background.

**Response:** `200 OK`
```json
{ "ok": true, "status": "connecting" }
```

**Error responses:**
- `404` -- Node not found

---

### POST /api/nodes/:nodeId/disconnect

Disconnects from a remote node. Kills the SSH tunnel and cleans up.

**Response:** `200 OK`
```json
{ "ok": true }
```

**Error responses:**
- `500` -- Failed to disconnect

---

### POST /api/nodes/test

Tests SSH connectivity to a node without saving or connecting.

**Request body:**
```json
{
  "host": "192.168.1.100",
  "port": 22,
  "user": "deploy",
  "sshKeyPath": "~/.ssh/id_ed25519"
}
```

**Response:** `200 OK`
```json
{
  "ok": true,
  "remoteInfo": "dev-server\nLinux\ndeploy"
}
```

**Error responses:**
- `400` -- Missing host, user, or sshKeyPath
- `500` -- Test failed

---

## Agent Endpoints (port 4681)

These endpoints are exposed by the agent's terminal server on each machine. The central server proxies to these endpoints when handling dashboard requests.

### GET /api/session-messages

Returns paginated session messages from the agent's local storage (JSONL files for Claude Code, SQLite for OpenCode).

**Query parameters:**
| Parameter   | Required | Default        | Description                      |
|-------------|----------|----------------|----------------------------------|
| `sessionId` | Yes      | --             | Agent session ID                 |
| `agentType` | No       | `"claude-code"` | Agent type                       |
| `offset`    | No       | `0`            | Pagination offset                |
| `limit`     | No       | `10`           | Number of messages to return     |

**Response:** `200 OK` -- `SessionMessagesResponse`

**Error responses:**
- `400` -- Missing sessionId
- `404` -- Session not found
- `500` -- Internal error

---

### POST /api/launch

Launches a new multiplexer session with an agent running inside it.

**Request body:**
```json
{
  "sessionName": "my-project",
  "projectDir": "/home/user/projects/my-project",
  "multiplexer": "zellij",
  "agentType": "claude-code",
  "zellijLayout": "agent",
  "model": "claude-sonnet-4-20250514",
  "autonomous": false
}
```

Creates a new zellij or tmux session, sends the agent launch command, and for Claude Code, auto-accepts the workspace trust prompt and sends an initial message to trigger JSONL creation.

**Response:** `200 OK`
```json
{ "ok": true }
```

**Error responses:**
- `400` -- Invalid session name, project directory, model, or unavailable agent type
- `500` -- Multiplexer session creation failed

---

### POST /api/resume

Resumes an existing agent session in a new multiplexer session.

**Request body:**
```json
{
  "sessionName": "my-project",
  "sessionId": "550e8400-e29b-41d4-a716-446655440000",
  "projectDir": "/home/user/projects/my-project",
  "multiplexer": "zellij",
  "agentType": "claude-code",
  "zellijLayout": "agent",
  "model": "claude-sonnet-4-20250514",
  "autonomous": false
}
```

**Response:** `200 OK`
```json
{ "ok": true }
```

**Error responses:**
- `400` -- Invalid session name, session ID, project directory, model, or unavailable agent type
- `500` -- Multiplexer session creation failed

---

### POST /api/reconnect

Reconnects an agent in an existing multiplexer session (where the agent exited but the terminal is still alive). Sends the resume command into the existing shell.

**Request body:**
```json
{
  "multiplexer": "zellij",
  "session": "my-session",
  "sessionId": "550e8400-e29b-41d4-a716-446655440000",
  "agentType": "claude-code",
  "model": "claude-sonnet-4-20250514"
}
```

**Response:** `200 OK`
```json
{ "ok": true }
```

**Error responses:**
- `400` -- Missing session/sessionId, invalid session ID/model, or unavailable agent type
- `500` -- Write/send command failed

---

### POST /api/kill

Kills (closes) a multiplexer session.

**Request body:**
```json
{
  "multiplexer": "zellij",
  "session": "my-session"
}
```

For zellij, uses `kill-session` which terminates running processes but leaves the session in EXITED state (allowing resume). For tmux, uses `kill-session` which fully removes the session.

**Response:** `200 OK`
```json
{ "ok": true }
```

**Error responses:**
- `400` -- Missing session
- `500` -- Failed to kill session

---

### POST /api/delete-session

Deletes a session's data files (JSONL for Claude Code, DB record for OpenCode).

**Request body:**
```json
{
  "sessionId": "550e8400-e29b-41d4-a716-446655440000",
  "agentType": "claude-code"
}
```

If `agentType` is not specified, defaults to `"claude-code"` and falls back to trying other providers.

**Response:** `200 OK`
```json
{ "ok": true }
```

**Error responses:**
- `400` -- Missing or invalid session ID
- `404` -- Session data not found
- `500` -- Failed to delete session

---

### POST /api/send

Sends text to a multiplexer session. Uses a PTY helper to attach to the session and write text. Handles differences between Claude Code (simple CLI) and OpenCode (Bubble Tea TUI with bracketed paste mode).

**Request body:**
```json
{
  "multiplexer": "zellij",
  "session": "my-session",
  "text": "fix the failing tests",
  "agentType": "claude-code"
}
```

**Response:** `200 OK`
```json
{ "ok": true }
```

**Error responses:**
- `400` -- Missing session or text
- `500` -- Failed to send

---

### POST /api/rename-session

Renames a multiplexer session (zellij or tmux). Stores a rename mapping so stale environment variables in shell processes can be resolved to the new name.

**Request body:**
```json
{
  "multiplexer": "zellij",
  "currentName": "old-name",
  "newName": "new-name"
}
```

**Response:** `200 OK`
```json
{ "ok": true }
```

**Error responses:**
- `400` -- Missing currentName or newName
- `500` -- Failed to rename session

---

### POST /api/hook-event

Receives hook/event data from AI coding agents (Claude Code hooks or OpenCode webhooks). Responds immediately to avoid slowing down the agent. Events are parsed by each registered provider until one recognizes the payload.

**Request body (Claude Code):**
```json
{
  "session_id": "550e8400-e29b-41d4-a716-446655440000",
  "hook_event_name": "PreToolUse",
  "tool_name": "Edit"
}
```

**Request body (OpenCode):**
```json
{
  "session_id": "ses_30163a6c1ffeYDGuDOrp0nH9vG",
  "event_type": "tool.execute.before",
  "tool_name": "file_write",
  "agent_type": "opencode"
}
```

**Response:** `200 OK`
```json
{ "exit": 0 }
```

Always returns `200` regardless of whether the event was recognized.

---

## WebSocket Protocols

### Dashboard WebSocket -- `/ws` (Server)

The dashboard connects to `ws://server:4680/ws` for real-time updates.

**Connection:** On connect, the server immediately sends the current machine state.

**Server-to-client messages:**

```typescript
interface WebSocketMessage {
  type: "machines_update";
  payload: MachineInfo[];
}
```

The server broadcasts a `machines_update` message whenever:
- A heartbeat is received from any agent
- A session is renamed
- A new session is launched (pending placeholder)

**Client-to-server messages:** None. The WebSocket is unidirectional (server to client only).

**Reconnection:** The dashboard automatically reconnects after 2 seconds if the connection is lost.

---

### Terminal WebSocket -- `/ws/terminal` (Server, proxied)

The dashboard connects to `ws://server:4680/ws/terminal` for terminal access. The server proxies this connection to the agent's terminal WebSocket.

**Query parameters:**
| Parameter     | Required | Default   | Description                     |
|---------------|----------|-----------|---------------------------------|
| `machineId`   | Yes      | --        | Machine identifier              |
| `session`     | Yes      | --        | Multiplexer session name        |
| `multiplexer` | No       | `"zellij"` | Terminal multiplexer type       |
| `cols`        | No       | `"120"`   | Terminal columns                |
| `rows`        | No       | `"40"`    | Terminal rows                   |

**Data flow:**
- Binary data from agent (terminal output) is forwarded to the browser
- Text/binary data from the browser (keyboard input) is forwarded to the agent

**Client-to-server messages:**
- Raw text/binary: forwarded as terminal input
- JSON resize message:
  ```json
  { "type": "resize", "cols": 120, "rows": 40 }
  ```

---

### Terminal WebSocket -- `/ws/terminal` (Agent)

The agent's terminal server exposes a direct WebSocket for terminal access.

**Query parameters:**
| Parameter     | Required | Default   | Description                     |
|---------------|----------|-----------|---------------------------------|
| `session`     | Yes      | --        | Multiplexer session name        |
| `multiplexer` | No       | `"zellij"` | Terminal multiplexer type       |
| `cols`        | No       | `"120"`   | Terminal columns                |
| `rows`        | No       | `"40"`    | Terminal rows                   |

On connection, the agent spawns a PTY helper process that attaches to the multiplexer session and streams terminal I/O over the WebSocket.

---

## Shared Types

All TypeScript types used in the API are defined in `shared/src/index.ts`.

### Core Types

```typescript
type AgentType = "claude-code" | "opencode";

type SessionStatus =
  | "starting"
  | "working"
  | "awaiting_input"
  | "action_required"
  | "idle"
  | "done"
  | "error"
  | "exited";

type TerminalMultiplexer = "zellij" | "tmux";

type NodeStatus = "disconnected" | "connecting" | "deploying" | "connected" | "error";
```

### SessionInfo

```typescript
interface SessionInfo {
  sessionId: string;
  agentType: AgentType;
  slug: string;
  customName?: string;
  projectPath: string;
  projectName: string;
  gitBranch: string;
  status: SessionStatus;
  lastActivity: string;       // ISO timestamp
  lastMessage: string;
  lastAssistantMessage?: string;
  cwd: string;
  model?: string;
  version?: string;
  multiplexerSession?: string;
  multiplexer?: TerminalMultiplexer;
  hookEnabled?: boolean;
  currentTool?: string;
}
```

### MachineInfo

```typescript
interface MachineInfo {
  machineId: string;
  hostname: string;
  platform: string;
  lastHeartbeat: string;
  sessions: SessionInfo[];
  multiplexers: TerminalMultiplexer[];
  multiplexerSessions: MultiplexerSessionInfo[];
  terminalPort?: number;
  agentAddress?: string;
}
```

### Settings

```typescript
interface Settings {
  defaultMultiplexer: TerminalMultiplexer;
  defaultAgentType: AgentType;
  zellijLayout: string;
  defaultModel?: string;
  autoDeleteOnClose: boolean;
  defaultProjectDir: string;
  fontSize: "small" | "medium" | "large";
  theme: "dark" | "light";
}
```

### RemoteNode

```typescript
interface RemoteNode {
  id: string;
  name: string;
  host: string;
  port: number;
  user: string;
  sshKeyPath: string;
  agentPort: number;
  status: NodeStatus;
  error?: string;
  lastConnected?: string;
  autoConnect: boolean;
  enableHooks: boolean;
}
```

### SessionMessage

```typescript
interface SessionMessage {
  role: "user" | "assistant";
  timestamp: string;
  content: string;
  toolUse?: { name: string; id: string }[];
  toolResult?: string;
  model?: string;
}

interface SessionMessagesResponse {
  messages: SessionMessage[];
  total: number;
  hasMore: boolean;
}
```
