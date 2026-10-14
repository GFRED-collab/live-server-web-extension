#!/bin/zsh
set -e

PROJECT_DIR="${0:A:h}"
NODE_BIN="/Users/gurshwinfredericks/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node"

if [[ ! -x "$NODE_BIN" ]]; then
  NODE_BIN="$(command -v node || true)"
fi

if [[ -z "$NODE_BIN" ]]; then
  echo "Node.js could not be found. Please install Node.js, then run this file again."
  read "?Press Return to close..."
  exit 1
fi

if [[ ! -f "$PROJECT_DIR/node_modules/next/dist/bin/next" ]]; then
  echo "Project dependencies are missing. Open Terminal in this folder and run: npm install"
  read "?Press Return to close..."
  exit 1
fi

cd "$PROJECT_DIR"

echo "Starting Oxygen Care Reports Server at http://localhost:3002"
"$NODE_BIN" node_modules/next/dist/bin/next dev --webpack --port 3002 &
SERVER_PID=$!
sleep 2
open "http://localhost:3002"
wait "$SERVER_PID"
