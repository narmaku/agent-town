# Agent Town

A lightweight dashboard to monitor and connect to AI coding agent sessions across machines on your home network. Supports **Claude Code** and **OpenCode** via a provider abstraction, with more agents easily added.

## Features

- **Multi-agent support**: Claude Code and OpenCode (extensible via provider plugins)
- Real-time session monitoring via WebSocket
- Status detection: Working, Awaiting Input, Action Required, Idle, Done, Error
- Multi-machine support over LAN (no VPN needed)
- Session renaming from the dashboard
- Terminal relay: attach to zellij/tmux sessions from the browser
- Launch and resume agent sessions from the dashboard
- Supports both **zellij** and **tmux**

## Architecture

```
Browser (dashboard)
  |
Server (:4680) --- receives heartbeats, serves dashboard, proxies terminals
  |
Agent (per machine) --- discovers sessions via providers, reports status, relays terminals
  |
zellij/tmux sessions --- where AI coding agents (Claude Code, OpenCode) run
```

## Quick Start (local dev)

```bash
cd ~/development/agent-town
./dev.sh
```

Open http://localhost:4680

## Best Practice: One Terminal Session Per Agent

For the best experience with Agent Town, run each AI coding agent in its **own named terminal session**. This makes it easy to attach to any agent directly from the dashboard.

### With zellij (recommended: minimal layout)

For the cleanest web terminal experience, create a minimal zellij layout without tab bar or status bar:

```bash
# Create the minimal layout (one-time setup)
mkdir -p ~/.config/zellij/layouts
cat > ~/.config/zellij/layouts/agent.kdl << 'EOF'
layout {
    pane borderless=true
}
EOF
```

Then create sessions using this layout:

```bash
# Create a named session for each project with minimal UI
zellij -s rubric-kit --layout agent
cd ~/development/rubric-kit && claude

# In another terminal
zellij -s evaluation-data --layout agent
cd ~/development/evaluation-data && claude

# And another
zellij -s deploy --layout agent
cd ~/development/lscore && claude
```

### With tmux

```bash
# Create named sessions
tmux new-session -d -s rubric-kit -c ~/development/rubric-kit
tmux send-keys -t rubric-kit "claude" Enter

tmux new-session -d -s evaluation-data -c ~/development/evaluation-data
tmux send-keys -t evaluation-data "claude" Enter

tmux new-session -d -s deploy -c ~/development/lscore
tmux send-keys -t deploy "claude" Enter
```

### Why one session per agent?

- **Clean attach**: Agent Town can attach to any session directly from the browser
- **No navigation**: You land right where Claude Code is running, not in a tab maze
- **Session names**: Give meaningful names that show up in the dashboard
- **Isolation**: Each agent has its own terminal environment

### Avoid: multiple agents in one session

Mixing multiple Claude Code agents in tabs/panes of a single session means you have to navigate to find the right one after attaching. Agent Town can still monitor all sessions, but the terminal attach won't know which tab to focus.

## Running Agent Town

### Option 1: Dev script (everything on one machine)

```bash
./dev.sh
```

Starts both the server and agent, builds the dashboard, opens on port 4680.

### Option 2: Multi-machine setup

On your Proxmox server (or any central machine):
```bash
# Start the server
bun run server/src/index.ts
```

On each machine with Claude Code sessions:
```bash
# Point the agent at the server
AGENT_TOWN_SERVER=http://<server-ip>:4680 bun run agent/src/index.ts
```

### Option 3: Run agent-town outside any multiplexer

For terminal relay to work reliably, the agent process should run **outside** of the multiplexer sessions it will attach to. Options:

```bash
# Run as a background process
nohup ./dev.sh > agent-town.log 2>&1 &

# Or run in its own dedicated tmux/zellij session
tmux new-session -d -s agent-town -c ~/development/agent-town './dev.sh'
```

## Environment Variables

| Variable | Default | Description |
|---|---|---|
| `AGENT_TOWN_PORT` | `4680` | Server port |
| `AGENT_TOWN_SERVER` | `http://localhost:4680` | Server URL (for agent) |
| `AGENT_TOWN_INTERVAL` | `5000` | Heartbeat interval in ms |
| `AGENT_TOWN_TERMINAL_PORT` | `4681` | Terminal WebSocket port (agent) |
| `AGENT_TOWN_MACHINE_ID` | auto (hostname hash) | Stable machine identifier |

## Dashboard Features

- **Click a card** to expand and see full session details
- **Double-click the slug** to rename a session
- **Open Terminal** button attaches to the multiplexer session from the browser
- If multiple terminal sessions exist, a picker appears
- **ESC ESC** (double press) closes the terminal overlay

## Project Structure

```
agent-town/
  agent/        # Runs on each machine, discovers sessions via provider plugins
    providers/  # Agent type plugins (claude-code, opencode)
  server/       # Central hub, receives heartbeats, serves dashboard
  dashboard/    # React SPA with real-time status cards
  shared/       # TypeScript types and logger shared across packages
```

## Tests

```bash
bun test
```
