#!/usr/bin/env bash
set -Eeuo pipefail
PROJECT_DIR="$(cd "$(dirname "$0")" && pwd)"
# Which install to update: ihs (default) or oxygen-care. Each has its own service and data.
INSTANCE="${1:-ihs}"
[[ "$INSTANCE" == ihs || "$INSTANCE" == oxygen-care ]] || { echo 'Usage: bash deploy-server.sh [ihs|oxygen-care]'; exit 1; }
SERVER_HOST="${SERVER_HOST:-192.168.0.248}"
SERVER_USER="${SERVER_USER:-serveradmin}"
SSH_KEY="${SSH_KEY:-$HOME/.ssh/oxygen-care-server}"
REMOTE="${SERVER_USER}@${SERVER_HOST}"
RELEASE="$(date -u +%Y%m%dT%H%M%SZ)"
STAGE_DIR="/tmp/occ-cloud-release-$RELEASE"
SSH=(ssh -o BatchMode=yes -o IgnoreUnknown=UseKeychain -o UseKeychain=yes -o IdentitiesOnly=yes -i "$SSH_KEY")
cd "$PROJECT_DIR"
npm run check
npm test
"${SSH[@]}" "$REMOTE" "umask 077; mkdir -p '$STAGE_DIR'"
tar -czf - package.json server.mjs sign-in-api.mjs qrcode-generator.cjs sync-api.mjs calendar-api.mjs groups-api.mjs updates-api.mjs public scripts Dockerfile compose.yaml README.md HARDENING.md .env.example |
  "${SSH[@]}" "$REMOTE" "tar -xzf - -C '$STAGE_DIR'"
# The terminal permits the administrator's normal sudo prompt without exposing the password.
"${SSH[@]}" -tt "$REMOTE" "bash '$STAGE_DIR/scripts/remote-install.sh' '$STAGE_DIR' '$RELEASE' '$INSTANCE'"
