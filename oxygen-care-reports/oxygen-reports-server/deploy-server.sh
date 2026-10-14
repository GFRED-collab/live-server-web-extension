#!/usr/bin/env bash
set -Eeuo pipefail

SERVER_HOST="${SERVER_HOST:-192.168.0.248}"
SERVER_USER="${SERVER_USER:-serveradmin}"
REMOTE="${SERVER_USER}@${SERVER_HOST}"
STAGE_DIR="/tmp/oxygen-care-reports-release"
PROJECT_DIR="$(cd "$(dirname "$0")" && pwd)"

command -v rsync >/dev/null || { echo "rsync is required on this Mac."; exit 1; }
command -v ssh >/dev/null || { echo "ssh is required on this Mac."; exit 1; }

(cd "$PROJECT_DIR" && npm test && npm run check)
ssh "$REMOTE" "mkdir -p '$STAGE_DIR'"
rsync --archive --delete \
  --exclude '.DS_Store' --exclude '.git' --exclude '.env' --exclude '.env.*' \
  --exclude '.next' --exclude 'node_modules' --exclude 'tsconfig.tsbuildinfo' \
  "$PROJECT_DIR/" "$REMOTE:$STAGE_DIR/"
ssh -tt "$REMOTE" "bash '$STAGE_DIR/scripts/remote-install.sh'"
