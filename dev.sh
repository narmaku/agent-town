#!/usr/bin/env bash
set -e

DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$DIR"

# Kill any previous agent-town processes
pkill -f "agent-town.*server/src/index" 2>/dev/null || true
pkill -f "agent-town.*agent/src/index" 2>/dev/null || true
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
  exit 0
}
trap cleanup INT TERM

# Start server
AGENT_TOWN_PORT=$PORT bun run server/src/index.ts &
SERVER_PID=$!

sleep 1

# Start agent — uses stable hostname-based ID by default (no override needed)
AGENT_TOWN_SERVER="http://localhost:$PORT" bun run agent/src/index.ts &
AGENT_PID=$!

wait $SERVER_PID $AGENT_PID
