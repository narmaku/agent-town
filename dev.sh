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

echo ""
echo "Starting Agent Town (dev mode)..."
echo "  Dashboard: http://localhost:$PORT"
echo "  API:       http://localhost:$PORT/api/machines"
echo "  Press Ctrl+C to stop"
echo ""

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

# Start agent — uses stable hostname-based ID by default (no override needed)
AGENT_TOWN_SERVER="http://localhost:$PORT" bun run agent/src/index.ts &
AGENT_PID=$!
echo $AGENT_PID > "$PID_DIR/agent.pid"

wait $SERVER_PID $AGENT_PID
