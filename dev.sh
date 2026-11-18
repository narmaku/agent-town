#!/usr/bin/env bash
set -e

DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$DIR"

PID_DIR="$HOME/.agent-town/pids"
mkdir -p "$PID_DIR"

# Stop previous agent-town processes using PID files.
# Unlike the old pkill -f approach, this only kills processes WE started,
# never unrelated bun processes or Claude Code sessions.
for pidfile in "$PID_DIR"/*.pid; do
  [ -f "$pidfile" ] || continue
  pid=$(cat "$pidfile")
  if kill -0 "$pid" 2>/dev/null; then
    kill "$pid" 2>/dev/null || true
  fi
  rm -f "$pidfile"
done
sleep 0.5

# Install deps if needed
if [ ! -d "node_modules" ]; then
  echo "Installing dependencies..."
  bun install
fi

# Build dashboard
echo "Building dashboard..."
cd dashboard && bunx vite build 2>&1 && cd ..

PORT="${AGENT_TOWN_PORT:-4680}"
TOKEN_FILE="${AGENT_TOWN_TOKEN_FILE:-$HOME/.agent-town/token}"

cleanup() {
  echo ""
  echo "Shutting down..."
  kill $SERVER_PID $AGENT_PID 2>/dev/null
  wait $SERVER_PID $AGENT_PID 2>/dev/null
  rm -f "$PID_DIR/server.pid" "$PID_DIR/agent.pid"
  exit 0
}
trap cleanup INT TERM

# Start server
AGENT_TOWN_PORT=$PORT bun run server/src/index.ts &
SERVER_PID=$!
echo $SERVER_PID > "$PID_DIR/server.pid"

sleep 1

# Start agent — uses stable hostname-based ID by default (no override needed).
# A loopback server URL makes the agent bind to 127.0.0.1 only.
AGENT_TOWN_SERVER="http://127.0.0.1:$PORT" bun run agent/src/index.ts &
AGENT_PID=$!
echo $AGENT_PID > "$PID_DIR/agent.pid"

# The server creates the token on first run; the login link carries it in the
# URL fragment, which the browser never sends to the server.
echo ""
echo "Starting Agent Town (dev mode)..."
if [ -r "$TOKEN_FILE" ]; then
  echo "  Dashboard: http://localhost:$PORT/#token=$(cat "$TOKEN_FILE")"
else
  echo "  Dashboard: http://localhost:$PORT (token: $TOKEN_FILE)"
fi
echo "  Press Ctrl+C to stop"
echo ""

wait $SERVER_PID $AGENT_PID
