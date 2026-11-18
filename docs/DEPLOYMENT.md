# Agent Town Deployment Guide

This document covers how to set up and run Agent Town in different configurations: local development, single-machine production, and multi-machine deployments.

---

## Prerequisites

- **Bun** (runtime): Install from https://bun.sh
- **Terminal multiplexer**: At least one of [zellij](https://zellij.dev) or [tmux](https://github.com/tmux/tmux)
- **AI coding agent**: At least one of [Claude Code](https://docs.anthropic.com/en/docs/claude-code), [OpenCode](https://github.com/opencode-ai/opencode), or [Gemini CLI](https://github.com/google-gemini/gemini-cli)
- **Python 3**: Required for the PTY helper (terminal relay)
- **Linux**: Full feature set. macOS works but lacks `/proc` filesystem (process mapping is limited) and `systemd-run` (cgroup isolation unavailable)

---

## Local Development Setup

### 1. Clone and install

```bash
git clone https://github.com/narmaku/agent-town.git
cd agent-town
bun install
```

### 2. Start everything with the dev script

```bash
./dev.sh
```

This script:
1. Kills any previously running Agent Town processes (using PID files in `~/.agent-town/pids/`)
2. Installs dependencies if `node_modules/` doesn't exist
3. Builds the dashboard (`bunx vite build`)
4. Starts the server on `127.0.0.1:4680`
5. Starts the agent pointing at `http://127.0.0.1:4680` (so it binds to `127.0.0.1:4681`)
6. Prints a login link: `http://localhost:4680/#token=<secret>`

Open the printed link in your browser. The token is read from the URL fragment
(which browsers never send to the server), kept in the tab's `sessionStorage`,
and removed from the address bar. A new tab or browser needs the link again, or
you can paste the token from `~/.agent-town/token` into the sign-in prompt.

### 3. (Optional) Create a minimal zellij layout

For the cleanest web terminal experience, create a zellij layout without the tab bar or status bar:

```bash
mkdir -p ~/.config/zellij/layouts
cat > ~/.config/zellij/layouts/agent.kdl << 'EOF'
layout {
    pane borderless=true
}
EOF
```

### 4. Launch agent sessions

You can launch sessions from the dashboard UI, or manually:

```bash
# With zellij
zellij -s my-project --layout agent
cd ~/projects/my-project && claude

# With tmux
tmux new-session -d -s my-project -c ~/projects/my-project
tmux send-keys -t my-project "claude" Enter
```

---

## Running as a systemd Service

For persistent operation, run Agent Town as a systemd user service.

### Create the service file

```bash
mkdir -p ~/.config/systemd/user

cat > ~/.config/systemd/user/agent-town.service << 'EOF'
[Unit]
Description=Agent Town Dashboard
After=network.target

[Service]
Type=simple
WorkingDirectory=%h/development/agent-town
ExecStart=%h/.bun/bin/bun run server/src/index.ts
Restart=on-failure
RestartSec=5

# Environment
Environment=AGENT_TOWN_PORT=4680
# Loopback only by default; set to 0.0.0.0 to serve the dashboard to the LAN
Environment=AGENT_TOWN_HOST=127.0.0.1
Environment=PATH=%h/.bun/bin:%h/.local/bin:%h/.opencode/bin:/usr/local/bin:/usr/bin:/bin

[Install]
WantedBy=default.target
EOF
```

For machines that also run the agent:

```bash
cat > ~/.config/systemd/user/agent-town-agent.service << 'EOF'
[Unit]
Description=Agent Town Agent
After=network.target agent-town.service

[Service]
Type=simple
WorkingDirectory=%h/development/agent-town
ExecStart=%h/.bun/bin/bun run agent/src/index.ts
Restart=on-failure
RestartSec=5

# Environment
Environment=AGENT_TOWN_SERVER=http://127.0.0.1:4680
Environment=AGENT_TOWN_TERMINAL_PORT=4681
Environment=PATH=%h/.bun/bin:%h/.local/bin:%h/.opencode/bin:/usr/local/bin:/usr/bin:/bin

[Install]
WantedBy=default.target
EOF
```

### Enable and start

```bash
systemctl --user daemon-reload
systemctl --user enable agent-town agent-town-agent
systemctl --user start agent-town agent-town-agent
```

### View logs

```bash
journalctl --user -u agent-town -f
journalctl --user -u agent-town-agent -f
```

### Sign in

The first service to start creates `~/.agent-town/token` (mode 600); the other
reads it. Build the login link with:

```bash
echo "http://localhost:4680/#token=$(cat ~/.agent-town/token)"
```

### Important: cgroup isolation

When running as a systemd service, launched multiplexer sessions (and the AI agents inside them) are children of the service's cgroup. Without isolation, `systemctl restart agent-town-agent` would kill all your AI agent sessions.

Agent Town automatically wraps multiplexer session creation in `systemd-run --scope` to place them in a separate cgroup. This is tested on startup -- check agent logs for:

```
cgroup isolation: systemd-run --scope works
```

If you see `systemd-run --scope not available`, ensure:
- `loginctl enable-linger $USER` has been run
- The user has an active systemd session (`XDG_RUNTIME_DIR` is set)

---

## Multi-Machine Setup

Agent Town supports monitoring AI agents across multiple machines via SSH tunnels.

### Architecture

```
Central server (machine A, port 4680)
  |
  +-- Local agent (port 4681)
  |     Monitors local zellij/tmux sessions
  |
  +-- SSH tunnel to machine B
  |     Deploys agent code, starts agent, establishes tunnels
  |
  +-- SSH tunnel to machine C
        Same as above
```

### Option 1: Automatic via dashboard (recommended)

1. Start Agent Town on the central machine:
   ```bash
   ./dev.sh
   ```

2. Open the login link that `./dev.sh` prints (`http://localhost:4680/#token=...`)

3. Go to Settings and add a new remote node with:
   - Display name
   - SSH hostname/IP
   - SSH port (default: 22)
   - SSH username
   - Path to SSH private key on the server machine
   - Agent port (default: 4681)
   - Auto-connect on startup (optional)
   - Enable Claude Code hooks (optional)

4. Click "Test Connection" to verify SSH access, then "Connect".

The server will:
- Deploy the agent code to `~/.agent-town-remote/` on the remote
- Install bun if needed
- Install dependencies
- Copy the server's access token to `~/.agent-town/token` on the remote (mode 600, over SSH stdin)
- Configure Claude Code hooks (if enabled)
- Start the agent process, bound to the remote's `127.0.0.1`
- Establish SSH tunnels (forward + reverse), both on loopback at each end

Nothing listens on the LAN in this setup: the server, the agents and the tunnels
all use loopback, and SSH carries the traffic between machines. This is the
recommended way to run multiple machines.

### Option 2: Manual agent setup over the LAN

Use this only when SSH tunnels are not an option. Agents and the server then
talk over the LAN in plain HTTP, protected by the shared token but **not
encrypted** — use it only on a network you trust (or over a VPN such as WireGuard
or Tailscale, binding to the VPN address instead of `0.0.0.0`).

On the central machine, start the server on a reachable interface:
```bash
AGENT_TOWN_HOST=0.0.0.0 bun run server/src/index.ts
```

Copy the server's token to each agent machine (same path, mode 600):
```bash
ssh user@agent-host 'umask 077 && mkdir -p ~/.agent-town && cat > ~/.agent-town/token' < ~/.agent-town/token
```

On each agent machine, clone the repo and start the agent:
```bash
cd ~/development/agent-town
AGENT_TOWN_SERVER=http://<server-ip>:4680 bun run agent/src/index.ts
```

Because the server URL is not loopback, the agent binds to `0.0.0.0` so the server
can dial back to it (override with `AGENT_TOWN_TERMINAL_HOST`). Restrict port 4681
to the server's IP with a firewall where you can.

### SSH Key Requirements

- The SSH key must be accessible on the server machine (path specified per node)
- Key-based authentication must be configured (no password prompts)
- The remote user must have write access to `~/` for deployment
- `rsync` must be available on both machines

---

## Environment Variables

### Server

| Variable                     | Default                 | Description                                                        |
|------------------------------|-------------------------|--------------------------------------------------------------------|
| `AGENT_TOWN_PORT`            | `4680`                  | HTTP/WebSocket port for the server                                 |
| `AGENT_TOWN_HOST`            | `127.0.0.1`             | Interface to bind. `0.0.0.0` exposes the dashboard and API to the LAN |
| `AGENT_TOWN_TOKEN_FILE`      | `~/.agent-town/token`   | Shared access token (created on first run, mode 600)               |
| `AGENT_TOWN_ALLOWED_ORIGINS` | *(empty)*               | Comma-separated extra browser origins allowed besides the dashboard's own |

### Agent

| Variable                    | Default                    | Description                              |
|-----------------------------|----------------------------|------------------------------------------|
| `AGENT_TOWN_SERVER`         | `http://127.0.0.1:4680`    | URL of the central server                |
| `AGENT_TOWN_INTERVAL`       | `5000`                     | Heartbeat interval in milliseconds       |
| `AGENT_TOWN_TERMINAL_PORT`  | `4681`                     | Terminal server HTTP/WebSocket port      |
| `AGENT_TOWN_TERMINAL_HOST`  | `127.0.0.1` if the server URL is loopback, else `0.0.0.0` | Interface the agent binds to |
| `AGENT_TOWN_TOKEN_FILE`     | `~/.agent-town/token`      | Shared access token; must match the server's |
| `AGENT_TOWN_ALLOWED_ORIGINS`| *(empty)*                  | Browser origins allowed to call the agent (normally none) |
| `AGENT_TOWN_MACHINE_ID`     | SHA-256 hash of hostname   | Stable machine identifier                |

### OpenCode (agent-side)

| Variable        | Default       | Description                              |
|-----------------|---------------|------------------------------------------|
| `OPENCODE_PORT` | `4096`        | OpenCode server port                     |
| `OPENCODE_HOST` | `127.0.0.1`   | OpenCode server host                     |

### Logging

| Variable    | Default | Description                                        |
|-------------|---------|-----------------------------------------------------|
| `LOG_LEVEL` | `info`  | Log level: `debug`, `info`, `warn`, `error`         |

---

## Data Storage

Agent Town stores persistent data in `~/.agent-town/`:

| File                     | Purpose                                      |
|--------------------------|----------------------------------------------|
| `token`                  | Shared access token (mode 600, directory 700) |
| `settings.json`          | Dashboard settings (multiplexer, theme, etc.) |
| `session-names.json`     | Custom session names (persists across restarts) |
| `nodes.json`             | Remote node configurations                   |
| `last-known-mux.json`    | Session-to-multiplexer mapping history       |
| `rename-map.json`        | Multiplexer session rename tracking          |
| `pids/`                  | PID files for dev script process management  |

---

## Security Considerations

### Network Exposure

Both processes bind to loopback by default: the server to `127.0.0.1:4680`, and the
agent to `127.0.0.1:4681` whenever its server URL is loopback (local or via SSH tunnel).
Nothing is reachable from the network unless you set `AGENT_TOWN_HOST` /
`AGENT_TOWN_TERMINAL_HOST` or point an agent at a LAN server.

### Request Guards

Every `/api/*` and `/ws*` request to the server or the agent must pass three checks,
in this order:

1. **Origin** — if the request carries an `Origin` header (every browser request
   does on WebSocket upgrades and cross-origin calls), it must be the dashboard's
   own origin or listed in `AGENT_TOWN_ALLOWED_ORIGINS`. The agent allows no browser
   origins by default, because only the server and local hooks should call it.
   Rejected with **403**. This blocks cross-site WebSocket hijacking and CSRF from
   any website open in your browser.
2. **Token** — the shared secret from `~/.agent-town/token`, sent as
   `Authorization: Bearer <token>`. Browsers cannot set headers on WebSockets, so
   upgrade requests may pass it as `?token=` instead (only upgrades; plain HTTP
   requests ignore the query parameter). Compared in constant time. Rejected with
   **401**. This blocks other hosts on the LAN, other local users' browsers, and DNS
   rebinding.
3. **Content-Type** — POST/PUT/PATCH bodies must be `application/json`
   (`multipart/form-data` on the two upload endpoints). Rejected with **415**. A
   cross-site HTML form can only send "simple" content types, so it can never reach
   a handler.

The dashboard's static files (`/`, `/assets/*`) are public so the sign-in prompt can
load. The agent's `/` is public as a tunnel health check and returns a fixed string.

### Access Token

- Generated on first run with 32 random bytes; stored at `~/.agent-town/token` with
  mode 600 inside a 700 directory. A looser mode is tightened on startup.
- Server and agent on the same machine share the file. For SSH nodes the server
  copies it to the remote over SSH stdin. For LAN agents, copy it yourself.
- Claude Code hooks read the token from the file each time they run
  (`$(cat ~/.agent-town/token)`), so the secret is never written into
  `~/.claude/settings.json`.
- The server never logs the token. `dev.sh` prints the login link to your terminal.
- To rotate it, stop everything, delete the file, and restart (then recopy it to
  any LAN agents and reconnect SSH nodes).

### SSH Tunnels

- SSH key files are referenced by path and never transmitted.
- Reverse tunnels expose the server port (4680) on remote machines -- bound to `127.0.0.1` of the remote.
- Forward tunnels expose the remote agent port on `127.0.0.1` of the server.
- The access token is installed on the remote via SSH stdin, never on a command line.

### Input Validation

- Session names are restricted to `[a-zA-Z0-9._-]` and max 100 characters.
- Project directories must be absolute paths without `..` traversal.
- Model names are validated against `[a-zA-Z0-9._:/-]`.
- Session IDs are validated against `[a-zA-Z0-9_-]`.
- Shell commands use array-form `Bun.spawn()` -- no string interpolation into shell commands.

### Agent Process Isolation

- Multiplexer sessions are launched in separate cgroup scopes (on systems with systemd) to survive agent restarts.
- The agent strips multiplexer environment variables (`ZELLIJ`, `TMUX`, etc.) before spawning new sessions to prevent nesting issues.

---

## Running Behind a Reverse Proxy

Example nginx configuration:

```nginx
server {
    listen 443 ssl;
    server_name agent-town.example.com;

    ssl_certificate /path/to/cert.pem;
    ssl_certificate_key /path/to/key.pem;

    location / {
        proxy_pass http://127.0.0.1:4680;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    }
}
```

The `Upgrade` and `Connection` headers are required for WebSocket support (dashboard updates and terminal relay).
Keep `proxy_set_header Host $host`: the origin check compares the browser's `Origin`
(`https://agent-town.example.com`) with the `Host` header. If your proxy rewrites
`Host`, add the public origin to `AGENT_TOWN_ALLOWED_ORIGINS` instead. The access
token is still required behind the proxy.
