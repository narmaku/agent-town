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
- Screen capture failures (`screen-status`)
- WebSocket connection/disconnection events
- SSH tunnel health checks
- Multiplexer session enumeration

---

## Common Issues

### Dashboard asks for an access token / "The access token was rejected"

**Cause:** The dashboard holds no token for this tab, or the server's token changed.
The token lives in the tab's `sessionStorage`, so each new tab or browser needs it once.

**Fix:** Open the login link again (`./dev.sh` prints it), or build it yourself on the
server machine and paste the token into the prompt:
```bash
echo "http://localhost:4680/#token=$(cat ~/.agent-town/token)"
```

If you deleted `~/.agent-town/token` to rotate it, restart both server and agent so
they read the new one, and recopy it to any LAN agents.

---

### API calls fail with 401, 403 or 415

Server and agent log every rejected request at `warn` level:
```
[warn] guard: rejected GET /api/machines: missing or invalid token
[warn] guard: rejected POST /api/agents/launch: origin not allowed (https://evil.example)
[warn] guard: rejected POST /api/settings: unsupported content-type (application/x-www-form-urlencoded)
```

- **401 Unauthorized** — no `Authorization: Bearer <token>` header, or the wrong token.
  For scripts and curl:
  ```bash
  curl -H "Authorization: Bearer $(cat ~/.agent-town/token)" http://127.0.0.1:4680/api/machines
  ```
- **403 Origin not allowed** — a browser page on another origin made the request.
  Expected for anything except the dashboard itself. If you serve the dashboard
  from another origin on purpose (e.g. the Vite dev server without its proxy, or a
  reverse proxy that rewrites `Host`), add it:
  `AGENT_TOWN_ALLOWED_ORIGINS=https://agent-town.example.com`.
- **415 Unsupported Media Type** — POST/PUT bodies must be sent with
  `Content-Type: application/json` (uploads: `multipart/form-data`).

---

### Machine missing, agent logs "heartbeat rejected: token mismatch"

**Cause:** The agent's `~/.agent-town/token` differs from the server's. This happens
with LAN agents (Option 2 in DEPLOYMENT.md) when the token was never copied, or
after the server's token was rotated.

**Fix:** Copy the server's token to the agent machine and restart the agent:
```bash
ssh user@agent-host 'umask 077 && mkdir -p ~/.agent-town && cat > ~/.agent-town/token' < ~/.agent-town/token
```

The reverse case shows up in the dashboard as **502 `agent_unauthorized`**
("Agent rejected the server's access token") on terminal, diff, send or launch
actions. The fix is the same. SSH nodes get the token automatically on each connect,
so reconnecting the node from Settings also fixes it.

---

### Dashboard or agent not reachable from another machine

**Cause:** Both bind to `127.0.0.1` by default.

**Fix:** For the dashboard, set `AGENT_TOWN_HOST=0.0.0.0` (or a specific LAN/VPN
address) on the server. For an agent that a remote server must dial directly, point
`AGENT_TOWN_SERVER` at the server's LAN address (the agent then binds `0.0.0.0`) or
set `AGENT_TOWN_TERMINAL_HOST` explicitly. Prefer SSH nodes, which need neither.
Check what is listening with:
```bash
ss -ltn | grep -E ':468[01]'
```

---

### Sessions not appearing in the dashboard

**Symptom:** AI agent is running but the dashboard shows no sessions.

**Check 1: Agent is running and connected**

Look at agent logs for heartbeat messages:
```
[info] agent: starting — machine=a1b2c3d4 host=my-machine server=http://127.0.0.1:4680 bind=127.0.0.1 interval=5000ms
[debug] agent: heartbeat: 3 sessions, 2 processes, 2 mapped, 0 unmatched
```

If the heartbeat is failing:
```
[error] agent: heartbeat failed: 404 Not Found
[error] agent: heartbeat rejected: token mismatch — /home/me/.agent-town/token must match the server's token
```

Verify the server URL is correct (`AGENT_TOWN_SERVER` env var), the server is running,
and both use the same token (see "heartbeat rejected: token mismatch" above).

**Check 2: Provider is registered**

On startup, the agent logs which providers are available:
```
[info] registry: registered provider: Claude Code (claude-code)
[info] registry: registered provider: OpenCode (opencode)
[info] registry: registered provider: Codex CLI (codex)
[info] registry: registered provider: Pi (pi)
```

If a provider is not available:
```
[info] registry: provider not available: Claude Code (claude not found)
```

Ensure the agent binary (`claude`, `opencode`, `gemini`, `codex`, or `pi`) is in the agent process's `$PATH`. When running as a systemd service, the `PATH` must be explicitly set in the service file. Pi's help output must identify it as the Pi coding agent; an unrelated system utility named `pi` is intentionally rejected.

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

For Codex CLI, verify the configured root and active session tree. Do not edit these files manually:
```bash
ls "${CODEX_HOME:-$HOME/.codex}"/state_*.sqlite
ls "${CODEX_HOME:-$HOME/.codex}"/sessions/*/*/*/*.jsonl
```

Agent Town reads a compatible database schema in read-only mode and otherwise falls back to bounded rollout scanning. Archived and subagent sessions are intentionally hidden.

For Pi, check the native session root without editing the files:
```bash
ls "${PI_CODING_AGENT_SESSION_DIR:-${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}/sessions}"/*/*.jsonl
```

Pi sessions form a tree. Agent Town displays only the ancestry of the last active leaf, so messages on an abandoned branch are intentionally absent. Current status is estimated from file activity and the running process.

**Check 4: Process mapper is working**

With `LOG_LEVEL=debug`, look for process mapper output:
```
[debug] mapper: pid=12345 agent=claude-code mux=my-project key=550e8400-e29b etimes=120
```

If no agent processes are found, the mapper logs nothing. Verify the agent is actually running:
```bash
ps aux | grep -E "claude|opencode|gemini|codex|pi" | grep -v grep
```

---

### Session shows wrong status

**Symptom:** Session shows "idle" or "exited" when the agent is running, or "working" when it is actually waiting for input.

**Cause:** Agent Town does not install hooks into agents. Status comes from the visible
terminal screen (approval prompts and "esc to interrupt" hints), child-process activity, and
session file modification times. It updates once per heartbeat, and only sessions running inside
a tmux or zellij session get screen-based detection.

**Solution:**
- Run agents inside tmux or zellij (or launch them from the dashboard) so the screen can be read.
- Check that `tmux capture-pane -p -t <session>` (or `zellij --session <session> action dump-screen /tmp/x`) works as the agent's user.
- If an agent changed the wording of its approval prompt, update `APPROVAL_PATTERNS` in `agent/src/screen-status.ts`.

For tmux, Agent Town also uses pane process ancestry and the pane working directory
when a restricted service cannot read another process's `/proc` files. Detached
sessions remain running even when no terminal viewer is attached. If you upgraded
from a version that showed these sessions as exited, restart the Agent Town agent
to load the fix; the tmux sessions do not need restarting.

Use **Terminal** to reconnect to a running agent. **Resume** starts another agent
process and is rejected when the latest heartbeat already reports that conversation
running in a terminal. A Codex message saying the conversation is open in another
app means another client owns it; resuming again does not transfer ownership.

---

### Terminal not connecting

**Symptom:** Clicking "Open Terminal" shows a blank screen or an error message.

**Check 1: Bun version**

The terminal relay uses Bun's built-in pseudo-terminal support (`Bun.spawn` with `terminal`), which needs Bun 1.3.5 or newer:
```bash
bun --version
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
curl http://127.0.0.1:4681/
# Should return: "Agent Town Terminal Server" (this path needs no token)
```

**Check 4: Network connectivity (multi-machine)**

For remote machines, the terminal connection goes through the SSH tunnel. Check tunnel health in server logs:
```
[debug] ssh: health: [my-node] tunnel healthy (127.0.0.1:14680)
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

**OpenCode:** Text is sent via bracketed paste mode through the PTY. The OpenCode TUI (Bubble Tea) handles a paste as a single event, then Enter submits it.

**Codex CLI:** Text is sent through the same bracketed-paste TUI path. A busy turn may defer input until Codex is ready.

**Pi:** Text is sent through bracketed-paste mode. Agent Town does not send a synthetic initial prompt or attempt to accept unrelated trust/disclaimer dialogs.

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

- Agent Town reads OpenCode's SQLite database read-only; no OpenCode server or SDK is needed.

### Codex CLI

- Local storage is private and versioned; an incompatible database falls back to active rollout JSONL discovery.
- Status is based on activity, process mapping, and the terminal screen; Agent Town installs no hooks.
- Resume and native delete require a full UUID. Delete failures are reported and Agent Town does not guess or unlink transcript paths.

### Pi

- Resume uses `pi --session <id>`; `pi --resume` is the interactive picker and is not used by Agent Town.
- Pi has no tool-approval or built-in sandbox layer, so Agent Town disables Auto and YOLO for Pi and explains its existing behavior in the permission mode information panel. Pi's separate project-trust prompt may still appear for project-local resources.
- Deletion locates the exact session header ID rather than guessing from timestamped filenames.
- `PI_CODING_AGENT_DIR` and `PI_CODING_AGENT_SESSION_DIR` must be visible to the Agent Town service environment.

---

## How to Report Bugs

1. Reproduce the issue with `LOG_LEVEL=debug` enabled.
2. Collect relevant log output from both the server and agent.
3. Include your environment details:
   - Operating system and version
   - Bun version (`bun --version`)
   - Multiplexer and version (`zellij --version` / `tmux -V`)
   - Agent type and version (`claude --version` / `opencode --version` / `gemini --version` / `codex --version` / `pi --version`)
4. Open an issue at https://github.com/narmaku/agent-town/issues with:
   - Steps to reproduce
   - Expected behavior
   - Actual behavior
   - Log output (with sensitive information redacted)


### Auto permission mode is unavailable or rejected

The permission selector shows every mode and disables modes the selected harness does not support. Open the (i) control for the reason and native behavior. OpenCode has no automatic safety-review equivalent; Pi has no built-in permission layer. Gemini Auto approves file edits only, so prompts for other tools are expected.

Codex Auto requires a CLI with `--approve-for-me`; Claude Code Auto requires `--permission-mode auto` and a supported model/organization policy. Upgrade an older CLI if it rejects these flags. Agent Town never falls back from Auto to YOLO. Default applies no override, so existing harness settings can already permit automatic actions.
