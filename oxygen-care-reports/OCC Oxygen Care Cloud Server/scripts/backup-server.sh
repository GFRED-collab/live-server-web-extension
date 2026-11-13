#!/usr/bin/env bash
set -Eeuo pipefail
[[ "$(id -u)" == 0 ]] || { echo 'Run this script with sudo on the server.'; exit 1; }
# Which install to back up: ihs (default) or oxygen-care, then an optional backup folder.
case "${1:-ihs}" in
  ihs) APP_NAME=occ-cloud ;;
  oxygen-care) APP_NAME=occ-cloud-oxygen ;;
  *) echo 'Usage: sudo bash backup-server.sh [ihs|oxygen-care] [backup folder]'; exit 1 ;;
esac
BACKUP_DIR="${2:-/var/backups/$APP_NAME}"
install -d -m 0700 "$BACKUP_DIR"
BACKUP_FILE="$BACKUP_DIR/$APP_NAME-$(date -u +%Y%m%dT%H%M%SZ).tar.gz"
[[ ! -e "$BACKUP_FILE" ]] || { echo 'A backup already exists at this timestamp.'; exit 1; }
WAS_ACTIVE=false
if systemctl is-active --quiet "$APP_NAME"; then WAS_ACTIVE=true; systemctl stop "$APP_NAME"; fi
restart(){ if [[ "$WAS_ACTIVE" == true ]]; then systemctl start "$APP_NAME"; fi; }
trap restart EXIT
umask 077
node "/opt/$APP_NAME/current/scripts/verify-data.mjs" "/var/lib/$APP_NAME"
tar -C "/var/lib/$APP_NAME" -czf "$BACKUP_FILE.partial" .
gzip -t "$BACKUP_FILE.partial"
mv "$BACKUP_FILE.partial" "$BACKUP_FILE"
sha256sum "$BACKUP_FILE" > "$BACKUP_FILE.sha256"
echo "Complete backup: $BACKUP_FILE"
