#!/usr/bin/env bash
set -e

DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$DIR"

# Install deps if needed
if [ ! -d "node_modules" ]; then
  echo "Installing dependencies..."
  bun install
fi

# Build dashboard
echo "Building dashboard..."
cd dashboard && bunx vite build && cd ..

# Generate a stable machine ID for this machine
MACHINE_ID_FILE="$DIR/.machine-id"
if [ ! -f "$MACHINE_ID_FILE" ]; then
  cat /proc/sys/kernel/random/uuid > "$MACHINE_ID_FILE" 2>/dev/null || uuidgen > "$MACHINE_ID_FILE"
fi
MACHINE_ID=$(cat "$MACHINE_ID_FILE")

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

# Start agent pointing at local server
AGENT_TOWN_SERVER="http://localhost:$PORT" AGENT_TOWN_MACHINE_ID="$MACHINE_ID" bun run agent/src/index.ts &
AGENT_PID=$!

wait $SERVER_PID $AGENT_PID
