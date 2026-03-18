# Agent Town Troubleshooting Guide

This document covers common issues, debugging techniques, and known limitations.

---

## Debug Logging

Agent Town uses structured logging with configurable levels. To enable verbose output:

```bash
LOG_LEVEL=debug ./dev.sh
```

Or for individual components:

```bash
# Server with debug logs
LOG_LEVEL=debug bun run server/src/index.ts

# Agent with debug logs
LOG_LEVEL=debug bun run agent/src/index.ts
```

Log levels (least to most verbose): `error`, `warn`, `info`, `debug`.

At `debug` level, you will see:
- Every heartbeat summary (session counts, mapping results)
- Process mapper decisions (which PIDs matched which sessions)
- Hook event processing
- WebSocket connection/disconnection events
- SSH tunnel health checks
- Multiplexer session enumeration

---

## Common Issues

### Sessions not appearing in the dashboard

**Symptom:** AI agent is running but the dashboard shows no sessions.

**Check 1: Agent is running and connected**

Look at agent logs for heartbeat messages:
```
[info] agent: starting — machine=a1b2c3d4 host=my-machine server=http://localhost:4680 interval=5000ms
[debug] agent: heartbeat: 3 sessions, 2 processes, 2 mapped, 0 unmatched
```

If the heartbeat is failing:
```
[error] agent: heartbeat failed: 404 Not Found
```

Verify the server URL is correct (`AGENT_TOWN_SERVER` env var) and the server is running.

**Check 2: Provider is registered**

On startup, the agent logs which providers are available:
```
[info] registry: registered provider: Claude Code (claude-code)
[info] registry: registered provider: OpenCode (opencode)
```

If a provider is not available:
```
[info] registry: provider not available: Claude Code (claude not found)
```

Ensure the agent binary (`claude` or `opencode`) is in the agent process's `$PATH`. When running as a systemd service, the `PATH` must be explicitly set in the service file.

**Check 3: Session data exists**

For Claude Code, sessions are stored as JSONL files:
```bash
ls ~/.claude/projects/*/
```

A new Claude Code session only creates a JSONL file after the first message exchange. If you just launched `claude` but haven't sent a message yet, no file exists. Agent Town creates a "placeholder" session in this case, but only if the process mapper can find the running `claude` process.

For OpenCode, sessions are in the SQLite database:
```bash
ls ~/.opencode/data.db
```

**Check 4: Process mapper is working**

With `LOG_LEVEL=debug`, look for process mapper output:
```
[debug] mapper: pid=12345 agent=claude-code mux=my-project key=550e8400-e29b etimes=120
```

If no agent processes are found, the mapper logs nothing. Verify the agent is actually running:
```bash
ps aux | grep -E "claude|opencode" | grep -v grep
```

---

### Session shows wrong status

**Symptom:** Session shows "idle" when the agent is actively working, or "working" when it is actually waiting for input.

**Cause:** Without hook events, status is derived from heuristics (JSONL file modification time, child process detection). These are less accurate.

**Solution:** Enable Claude Code hooks for more accurate real-time status:

```bash
# Create or update ~/.claude/settings.json
# The agent automatically configures hooks for remote nodes (if enableHooks=true)
# For local machines, add hooks manually:
```

Check if hooks are active in the dashboard -- sessions with hooks show more granular status updates (including the current tool being used).

For OpenCode, ensure the OpenCode server is running (`opencode serve --port 4096`) so the SSE event stream works.

---

### Terminal not connecting

**Symptom:** Clicking "Open Terminal" shows a blank screen or an error message.

**Check 1: PTY helper is available**

The terminal relay requires Python 3:
```bash
which python3
```

**Check 2: Multiplexer session exists**

The terminal connects to a specific multiplexer session by name. If the session was killed or renamed externally, the connection will fail. Check:
```bash
zellij list-sessions
tmux list-sessions
```

**Check 3: Agent terminal server is running**

Verify the agent's terminal server is listening:
```bash
curl http://localhost:4681/
# Should return: "Agent Town Terminal Server"
```

**Check 4: Network connectivity (multi-machine)**

For remote machines, the terminal connection goes through the SSH tunnel. Check tunnel health in server logs:
```
[debug] ssh: health: [my-node] tunnel healthy (localhost:14680)
```

If the tunnel is unhealthy:
```
[warn] ssh: health: [my-node] SSH tunnel exited (code 255), reconnecting...
```

**Check 5: Multiplexer nesting**

If the Agent Town agent itself is running inside a zellij or tmux session, attaching to another session may cause nesting issues. The agent strips multiplexer env vars (`ZELLIJ`, `ZELLIJ_SESSION_NAME`, `TMUX`, `TMUX_PANE`) before spawning attach commands, but in some cases this may not be sufficient. Running the agent outside any multiplexer session is recommended.

---

### "Send Message" not working

**Symptom:** Sending text to a session from the dashboard has no effect.

**Claude Code:** Text is written to the PTY and submitted with Enter. If Claude Code is in the middle of a tool execution, it may not accept input until it stops.

**OpenCode:** Text is sent via bracketed paste mode through the PTY. The OpenCode TUI (Bubble Tea) requires specific handling. If the OpenCode SDK is available, the provider also attempts to use `tui.appendPrompt` / `tui.submitPrompt` for more reliable delivery.

For multi-line text, a backup Enter is sent via native multiplexer commands (`zellij action write 13` or `tmux send-keys Enter`) after the PTY write, in case the PTY carriage return was swallowed.

---

### Remote node stuck in "connecting" or "deploying"

**Symptom:** A remote node shows "connecting" or "deploying" status indefinitely.

**Check 1: SSH connectivity**

Use the "Test Connection" button in the dashboard, or manually:
```bash
ssh -i ~/.ssh/id_ed25519 user@host "echo ok"
```

Common issues:
- SSH key permissions (must be `600` or `400`)
- Key not authorized on remote (`~/.ssh/authorized_keys`)
- Firewall blocking SSH port
- Hostname resolution failure

**Check 2: Deployment logs**

Check server logs for deployment progress:
```
[info] ssh: deploy: [my-node] phase 1/4 — creating remote directory
[info] ssh: deploy: [my-node] phase 2/4 — syncing source code via rsync
[info] ssh: deploy: [my-node] phase 4/4 — running setup script
```

If deployment fails:
```
[error] ssh: connect: my-node — failed: Deploy script failed: ...
```

Common deployment issues:
- `rsync` not installed on server or remote
- No internet access on remote (bun installation requires `curl` + internet)
- Disk space issues on remote

**Check 3: Bun availability on remote**

The deployment script installs bun to `~/.bun/` if not found. If installation fails, check manually:
```bash
ssh user@host "~/.bun/bin/bun --version"
```

---

### Machine disappears from dashboard

**Symptom:** A machine briefly appears then vanishes.

**Cause:** Machines are removed after 30 seconds without a heartbeat. If the agent crashes or the network connection drops, the machine disappears.

Check agent logs for errors:
```bash
journalctl --user -u agent-town-agent -f
```

Common causes:
- Agent process crashed (check for unhandled exceptions)
- Network connectivity issue between agent and server
- Server restarted (machines rebuild from heartbeats)

---

### Duplicate machines in dashboard

**Symptom:** The same hostname appears twice with different sessions.

**Cause:** This can happen if the machine ID changes (e.g., hostname changed, or `AGENT_TOWN_MACHINE_ID` was set then unset). The server deduplicates by hostname on each heartbeat, so duplicates should resolve within one heartbeat cycle.

If duplicates persist, restart the agent to force a fresh registration.

---

### Exited sessions not detected

**Symptom:** An agent exited from a multiplexer session, but the dashboard still shows it as "idle" instead of "exited".

**Cause:** The exited-session detection relies on two mechanisms:
1. Historical tracking: the session was previously seen with a multiplexer mapping
2. Name matching: the session's custom name or slug matches an unclaimed multiplexer session

If neither matches, the session will show as "idle".

**Solution:** Ensure sessions have names that match their multiplexer sessions. The dashboard auto-persists multiplexer session names, so this should work for any session that has been seen at least once while running.

---

## Known Limitations

### Platform-specific

- **macOS:** Process-to-multiplexer mapping is limited because `/proc` filesystem is not available. The agent falls back to less reliable methods.
- **macOS:** `systemd-run --scope` is unavailable, so multiplexer sessions launched by the agent are in the same process group. Restarting the agent may kill active sessions.

### Terminal relay

- Terminal resize may have brief visual artifacts during resize events.
- The PTY helper adds a small latency to terminal interactions compared to direct multiplexer attach.
- Very fast terminal output (e.g., large `cat` output) may experience buffering delays.

### Process mapping

- Freshly launched sessions (before the first message exchange) may take up to one heartbeat cycle (5s) to appear in the dashboard.
- If multiple agent processes are running in the same directory without `--resume` flags, the process mapper may occasionally map to the wrong session (it uses JSONL file birth time as a heuristic).
- Zombie processes with stale `ZELLIJ_SESSION_NAME` env vars can cause incorrect mappings. The rename map mitigates this for renamed sessions, but not for sessions killed externally.

### Multi-machine

- Remote agent deployment requires `rsync` on both machines.
- Remote bun installation requires internet access.
- SSH tunnel reconnection may take up to 20 seconds (health check interval + reconnect delay).
- Only one SSH tunnel per remote node is supported.

### OpenCode

- Requires the OpenCode server to be running (`opencode serve --port 4096`) for SDK features.
- The SDK client retries every 30 seconds if the server is unavailable.
- SSE event stream may disconnect and needs to reconnect.

---

## How to Report Bugs

1. Reproduce the issue with `LOG_LEVEL=debug` enabled.
2. Collect relevant log output from both the server and agent.
3. Include your environment details:
   - Operating system and version
   - Bun version (`bun --version`)
   - Multiplexer and version (`zellij --version` / `tmux -V`)
   - Agent type and version (`claude --version` / `opencode --version`)
4. Open an issue at https://github.com/narmaku/agent-town/issues with:
   - Steps to reproduce
   - Expected behavior
   - Actual behavior
   - Log output (with sensitive information redacted)
