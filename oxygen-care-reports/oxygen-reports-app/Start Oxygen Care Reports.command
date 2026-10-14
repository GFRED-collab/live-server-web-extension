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

# Documents is synchronised by iCloud on this Mac. Its large Next.js compiler
# file can be offloaded between launches, which prevents the local server from
# starting. Restore the matching Intel compiler from Next's local cache when
# needed (Apple silicon Macs use a different compiler package).
SWC_TARGET="$PROJECT_DIR/node_modules/@next/swc-darwin-x64/next-swc.darwin-x64.node"
SWC_CACHE="/Users/gurshwinfredericks/Library/Caches/next-swc/swc-darwin-x64-16.3.0.tgz"

if [[ "$(uname -m)" == "x86_64" && ! -s "$SWC_TARGET" ]]; then
  if [[ ! -f "$SWC_CACHE" ]]; then
    echo "The local Next.js compiler is unavailable. Connect to the internet, run npm install in this folder once, then launch again."
    read "?Press Return to close..."
    exit 1
  fi
  SWC_TEMP_DIR="$(mktemp -d /private/tmp/oxygen-care-swc.XXXXXX)"
  tar -xzf "$SWC_CACHE" -C "$SWC_TEMP_DIR"
  mkdir -p "${SWC_TARGET:h}"
  cp "$SWC_TEMP_DIR/package/next-swc.darwin-x64.node" "$SWC_TARGET"
fi

cd "$PROJECT_DIR"

echo "Starting Oxygen Care Reports at http://localhost:3001"
"$NODE_BIN" node_modules/next/dist/bin/next dev --webpack --port 3001 &
SERVER_PID=$!
sleep 2
open "http://localhost:3001"
wait "$SERVER_PID"
