#!/usr/bin/env bash
set -Eeuo pipefail

SERVER_HOST="${SERVER_HOST:-192.168.0.248}"
SERVER_USER="${SERVER_USER:-serveradmin}"
REMOTE="${SERVER_USER}@${SERVER_HOST}"
STAGE_DIR="/tmp/oxygen-care-expenses-release"
PROJECT_DIR="$(cd "$(dirname "$0")" && pwd)"

command -v rsync >/dev/null || { echo "rsync is required on this Mac."; exit 1; }
command -v ssh >/dev/null || { echo "ssh is required on this Mac."; exit 1; }

"$(command -v node)" --check "$PROJECT_DIR/server.mjs"
"$(command -v node)" --check "$PROJECT_DIR/public/app.js"
(cd "$PROJECT_DIR" && node --test test/static-integrity.test.mjs)

# This directory contains only disposable deployment staging files. Recreate it
# for every release so files from an older deployment cannot remain callable.
ssh "$REMOTE" "rm -rf '$STAGE_DIR' && mkdir -p '$STAGE_DIR/public' '$STAGE_DIR/test' '$STAGE_DIR/scripts'"
rsync --archive --delete "$PROJECT_DIR/public/" "$REMOTE:$STAGE_DIR/public/"
rsync --archive --delete "$PROJECT_DIR/test/" "$REMOTE:$STAGE_DIR/test/"
rsync --archive "$PROJECT_DIR/server.mjs" "$PROJECT_DIR/package.json" "$PROJECT_DIR/package-lock.json" "$REMOTE:$STAGE_DIR/"
rsync --archive "$PROJECT_DIR/scripts/remote-update.sh" "$REMOTE:$STAGE_DIR/remote-update.sh"
rsync --archive "$PROJECT_DIR/scripts/maintenance-cleanup.mjs" "$REMOTE:$STAGE_DIR/scripts/maintenance-cleanup.mjs"
rsync --archive "$PROJECT_DIR/scripts/rapidocr_text.py" "$PROJECT_DIR/scripts/rapidocr-requirements.txt" "$PROJECT_DIR/scripts/paddleocr_text.py" "$PROJECT_DIR/scripts/paddleocr-requirements.txt" "$REMOTE:$STAGE_DIR/scripts/"

ssh -tt "$REMOTE" "bash '$STAGE_DIR/remote-update.sh'"
