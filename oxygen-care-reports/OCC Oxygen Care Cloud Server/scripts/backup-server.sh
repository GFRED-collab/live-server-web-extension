#!/usr/bin/env bash
set -Eeuo pipefail
[[ "$(id -u)" == 0 ]] || { echo 'Run this script with sudo on the Oxygen Care server.'; exit 1; }
BACKUP_DIR="${1:-/var/backups/occ-cloud}"
install -d -m 0700 "$BACKUP_DIR"
BACKUP_FILE="$BACKUP_DIR/occ-cloud-$(date -u +%Y%m%dT%H%M%SZ).tar.gz"
[[ ! -e "$BACKUP_FILE" ]] || { echo 'A backup already exists at this timestamp.'; exit 1; }
WAS_ACTIVE=false
if systemctl is-active --quiet occ-cloud; then WAS_ACTIVE=true; systemctl stop occ-cloud; fi
restart(){ if [[ "$WAS_ACTIVE" == true ]]; then systemctl start occ-cloud; fi; }
trap restart EXIT
umask 077
node /opt/occ-cloud/current/scripts/verify-data.mjs /var/lib/occ-cloud
tar -C /var/lib/occ-cloud -czf "$BACKUP_FILE.partial" .
gzip -t "$BACKUP_FILE.partial"
mv "$BACKUP_FILE.partial" "$BACKUP_FILE"
sha256sum "$BACKUP_FILE" > "$BACKUP_FILE.sha256"
echo "Complete backup: $BACKUP_FILE"
