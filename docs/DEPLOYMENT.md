# Agent Town Deployment Guide

This document covers how to set up and run Agent Town in different configurations: local development, single-machine production, and multi-machine deployments.

---

## Prerequisites

- **Bun** (runtime): Install from https://bun.sh
- **Terminal multiplexer**: At least one of [zellij](https://zellij.dev) or [tmux](https://github.com/tmux/tmux)
- **AI coding agent**: At least one of [Claude Code](https://docs.anthropic.com/en/docs/claude-code) or [OpenCode](https://github.com/opencode-ai/opencode)
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
4. Starts the server on port 4680
5. Starts the agent pointing at `http://localhost:4680`

Open http://localhost:4680 in your browser.

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
Environment=AGENT_TOWN_SERVER=http://localhost:4680
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

2. Open the dashboard at http://localhost:4680

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
- Configure Claude Code hooks (if enabled)
- Start the agent process
- Establish SSH tunnels (forward + reverse)

### Option 2: Manual agent setup

On the central machine, start only the server:
```bash
bun run server/src/index.ts
```

On each remote machine, clone the repo and start the agent:
```bash
cd ~/development/agent-town
AGENT_TOWN_SERVER=http://<server-ip>:4680 bun run agent/src/index.ts
```

This requires direct network connectivity from each agent to the server (no SSH tunnels).

### SSH Key Requirements

- The SSH key must be accessible on the server machine (path specified per node)
- Key-based authentication must be configured (no password prompts)
- The remote user must have write access to `~/` for deployment
- `rsync` must be available on both machines

---

## Environment Variables

### Server

| Variable          | Default          | Description                              |
|-------------------|------------------|------------------------------------------|
| `AGENT_TOWN_PORT` | `4680`           | HTTP/WebSocket port for the server       |

### Agent

| Variable                    | Default                    | Description                              |
|-----------------------------|----------------------------|------------------------------------------|
| `AGENT_TOWN_SERVER`         | `http://localhost:4680`    | URL of the central server                |
| `AGENT_TOWN_INTERVAL`       | `5000`                     | Heartbeat interval in milliseconds       |
| `AGENT_TOWN_TERMINAL_PORT`  | `4681`                     | Terminal server HTTP/WebSocket port      |
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
| `settings.json`          | Dashboard settings (multiplexer, theme, etc.) |
| `session-names.json`     | Custom session names (persists across restarts) |
| `nodes.json`             | Remote node configurations                   |
| `last-known-mux.json`    | Session-to-multiplexer mapping history       |
| `rename-map.json`        | Multiplexer session rename tracking          |
| `pids/`                  | PID files for dev script process management  |

---

## Security Considerations

### Network Exposure

- The server binds to `0.0.0.0` by default -- it is accessible from any network interface.
- There is **no authentication** on the HTTP API or WebSocket connections.
- For production use on a network, place the server behind a reverse proxy with authentication (e.g., nginx with basic auth, or a VPN).

### SSH Tunnels

- SSH key files are referenced by path and never transmitted.
- Reverse tunnels expose the server port (4680) on remote machines -- only accessible on `localhost` of the remote.
- Forward tunnels expose the remote agent port on `localhost` of the server.

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
        proxy_pass http://localhost:4680;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    }
}
```

The `Upgrade` and `Connection` headers are required for WebSocket support (dashboard updates and terminal relay).
