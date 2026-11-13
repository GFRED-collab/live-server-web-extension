#!/usr/bin/env bash
set -Eeuo pipefail
STAGE_DIR="${1:?Staged release directory is required}"
RELEASE="${2:?Release identifier is required}"
[[ "$RELEASE" =~ ^[0-9]{8}T[0-9]{6}Z$ ]] || { echo 'Invalid release identifier.'; exit 1; }
[[ "$STAGE_DIR" == "/tmp/occ-cloud-release-$RELEASE" ]] || { echo 'Unexpected staging directory.'; exit 1; }
INSTANCE="${3:-ihs}"
# Installs share code, never data: each has its own service, system user, folders, settings
# file (with its own encryption key), ports and public addresses. Public addresses are served
# through Cloudflare Tunnel and accepted alongside the Tailscale one.
case "$INSTANCE" in
  ihs)
    APP_NAME=occ-cloud APP_USER=occcloud APP_PORT=3003 HTTPS_PORT=8444
    BRAND=ihs BRAND_NAME='Irish Hospital Supplies Cloud'
    PUBLIC_HOSTS=(cloud.kobalinesystems.com cloud.kobaline.com) ;;
  oxygen-care)
    APP_NAME=occ-cloud-oxygen APP_USER=occoxygen APP_PORT=3004 HTTPS_PORT=8445
    BRAND=oxygen-care BRAND_NAME='Oxygen Care Cloud'
    PUBLIC_HOSTS=(occ.kobaline.ie) ;;
  *) echo 'Unknown install. Use ihs or oxygen-care.'; exit 1 ;;
esac
APP_DIR=/opt/$APP_NAME
DATA_DIR=/var/lib/$APP_NAME
ENV_DIR=/etc/$APP_NAME
ENV_FILE=$ENV_DIR/$APP_NAME.env
BACKUP_DIR=/var/backups/$APP_NAME
SERVICE_FILE=/etc/systemd/system/$APP_NAME.service
TAILSCALE_HOST=expenses.fynbos-spectrum.ts.net
for tool in node tailscale curl ss openssl; do command -v "$tool" >/dev/null || { echo "$tool is required."; exit 1; }; done
node --input-type=module -e "import {DatabaseSync} from 'node:sqlite'; const d=new DatabaseSync(':memory:');d.close()"
[[ -f "$STAGE_DIR/server.mjs" && -f "$STAGE_DIR/sign-in-api.mjs" && -f "$STAGE_DIR/qrcode-generator.cjs" && -f "$STAGE_DIR/sync-api.mjs" && -f "$STAGE_DIR/updates-api.mjs" && -f "$STAGE_DIR/groups-api.mjs" && -f "$STAGE_DIR/calendar-api.mjs" && -f "$STAGE_DIR/public/app.js" ]] || { echo 'Release files are incomplete.'; exit 1; }
sudo -v
if ! sudo systemctl is-active --quiet "$APP_NAME" && ss -ltnH | awk '{print $4}' | grep -Eq ":$APP_PORT$"; then echo "Port $APP_PORT is already used. Deployment stopped."; exit 1; fi
if ! sudo test -f "$ENV_FILE" && sudo tailscale serve status --json | grep -q "\"$HTTPS_PORT\""; then echo "HTTPS port $HTTPS_PORT is already configured. Deployment stopped."; exit 1; fi
if ! id "$APP_USER" >/dev/null 2>&1; then sudo useradd --system --home-dir "$APP_DIR" --shell /usr/sbin/nologin "$APP_USER"; fi
sudo install -d -o root -g "$APP_USER" -m 0750 "$APP_DIR" "$APP_DIR/releases" "$ENV_DIR"
sudo install -d -o "$APP_USER" -g "$APP_USER" -m 0700 "$DATA_DIR"
if ! sudo test -f "$ENV_FILE"; then
  cat > "$STAGE_DIR/$APP_NAME.env" <<ENV
NODE_ENV=production
HOST=127.0.0.1
PORT=$APP_PORT
APP_ORIGIN=https://$TAILSCALE_HOST:$HTTPS_PORT
OCC_DATA_DIR=$DATA_DIR
MAX_FILE_BYTES=100000000
STORAGE_QUOTA_BYTES=5000000000
TRUST_PROXY=1
ENV
  sudo install -o root -g "$APP_USER" -m 0640 "$STAGE_DIR/$APP_NAME.env" "$ENV_FILE"
fi
# The brand this install shows. Older settings files predate it.
if ! sudo grep -q '^OCC_BRAND=' "$ENV_FILE"; then
  echo "OCC_BRAND=$BRAND" | sudo tee -a "$ENV_FILE" >/dev/null
fi
# Every public address must be in APP_EXTRA_ORIGINS: add any that are missing, keep the rest.
CURRENT_ORIGINS="$(sudo sed -n 's/^APP_EXTRA_ORIGINS=//p' "$ENV_FILE" | tail -n 1 | tr -d "'\"")"
WANTED_ORIGINS="$CURRENT_ORIGINS"
for host in "${PUBLIC_HOSTS[@]}"; do
  case ",$WANTED_ORIGINS," in
    *",https://$host,"*) ;;
    *) WANTED_ORIGINS="${WANTED_ORIGINS:+$WANTED_ORIGINS,}https://$host" ;;
  esac
done
if [[ "$WANTED_ORIGINS" != "$CURRENT_ORIGINS" ]]; then
  sudo sed -i '/^APP_EXTRA_ORIGINS=/d' "$ENV_FILE"
  echo "APP_EXTRA_ORIGINS=$WANTED_ORIGINS" | sudo tee -a "$ENV_FILE" >/dev/null
fi
# Authenticator keys are stored encrypted with MFA_ENCRYPTION_KEY. Create it once; never change or remove it,
# or everyone has to set up their authenticator again. Keep a copy of this file with the data backups.
if ! sudo grep -q '^MFA_ENCRYPTION_KEY=' "$ENV_FILE"; then
  echo "MFA_ENCRYPTION_KEY=$(openssl rand -base64 32)" | sudo tee -a "$ENV_FILE" >/dev/null
  echo "Created MFA_ENCRYPTION_KEY in $ENV_FILE."
fi
sudo install -d -o root -g "$APP_USER" -m 0750 "$APP_DIR/releases/$RELEASE"
sudo cp -R "$STAGE_DIR/server.mjs" "$STAGE_DIR/sign-in-api.mjs" "$STAGE_DIR/qrcode-generator.cjs" "$STAGE_DIR/sync-api.mjs" "$STAGE_DIR/calendar-api.mjs" "$STAGE_DIR/groups-api.mjs" "$STAGE_DIR/updates-api.mjs" "$STAGE_DIR/package.json" "$STAGE_DIR/public" "$STAGE_DIR/scripts" "$STAGE_DIR/README.md" "$STAGE_DIR/HARDENING.md" "$APP_DIR/releases/$RELEASE/"
sudo chown -R root:"$APP_USER" "$APP_DIR/releases/$RELEASE"
sudo chmod -R u=rwX,g=rX,o= "$APP_DIR/releases/$RELEASE"
sudo -u "$APP_USER" node --check "$APP_DIR/releases/$RELEASE/server.mjs"
sudo -u "$APP_USER" node --check "$APP_DIR/releases/$RELEASE/public/app.js"
sudo -u "$APP_USER" node --check "$APP_DIR/releases/$RELEASE/sync-api.mjs"
sudo -u "$APP_USER" node --check "$APP_DIR/releases/$RELEASE/sign-in-api.mjs"
sudo -u "$APP_USER" node --check "$APP_DIR/releases/$RELEASE/calendar-api.mjs"
sudo -u "$APP_USER" node --check "$APP_DIR/releases/$RELEASE/groups-api.mjs"
sudo -u "$APP_USER" node --check "$APP_DIR/releases/$RELEASE/updates-api.mjs"
BACKUP_READY=0
OLD_UNIT="$STAGE_DIR/previous-$APP_NAME.service"
if sudo test -f "$SERVICE_FILE"; then sudo cp "$SERVICE_FILE" "$OLD_UNIT"; fi
OLD_RELEASE="$(sudo readlink "$APP_DIR/current" || true)"
rollback(){
  echo 'OCC verification failed; restoring the previous release.'
  sudo journalctl -u "$APP_NAME" -n 30 --no-pager || true
  sudo systemctl stop "$APP_NAME" || true
  if [[ "$BACKUP_READY" == 1 ]]; then
    sudo mv "$DATA_DIR" "$DATA_DIR.failed-$RELEASE"
    sudo install -d -o "$APP_USER" -g "$APP_USER" -m 0700 "$DATA_DIR"
    sudo tar -C "$DATA_DIR" -xzf "$BACKUP_DIR/pre-$RELEASE.tar.gz"
  fi
  if sudo test -f "$OLD_UNIT"; then sudo cp "$OLD_UNIT" "$SERVICE_FILE"; sudo systemctl daemon-reload; fi
  if [[ -n "$OLD_RELEASE" ]]; then sudo ln -sfn "$OLD_RELEASE" "$APP_DIR/current"; sudo systemctl start "$APP_NAME" || true; fi
}
trap rollback ERR
if sudo test -f "$DATA_DIR/occ.sqlite"; then
  sudo systemctl stop "$APP_NAME"
  sudo install -d -o root -g root -m 0700 "$BACKUP_DIR"
  sudo tar -C "$DATA_DIR" -czf "$BACKUP_DIR/pre-$RELEASE.tar.gz" .
  sudo chmod 0600 "$BACKUP_DIR/pre-$RELEASE.tar.gz"
  BACKUP_READY=1
fi
cat > "$STAGE_DIR/$APP_NAME.service" <<SERVICE
[Unit]
Description=$BRAND_NAME
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=$APP_USER
Group=$APP_USER
WorkingDirectory=$APP_DIR/current
EnvironmentFile=$ENV_FILE
ExecStart=/usr/bin/node $APP_DIR/current/server.mjs
Restart=on-failure
RestartSec=5
UMask=0077
NoNewPrivileges=true
PrivateTmp=true
PrivateDevices=true
ProtectKernelTunables=true
ProtectKernelModules=true
ProtectKernelLogs=true
ProtectControlGroups=true
ProtectClock=true
RestrictSUIDSGID=true
RestrictRealtime=true
LockPersonality=true
CapabilityBoundingSet=
AmbientCapabilities=
RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6
TasksMax=64
LimitNOFILE=4096
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=$DATA_DIR
MemoryMax=512M
TimeoutStopSec=45

[Install]
WantedBy=multi-user.target
SERVICE
sudo install -o root -g root -m 0644 "$STAGE_DIR/$APP_NAME.service" "$SERVICE_FILE"
sudo ln -sfn "$APP_DIR/releases/$RELEASE" "$APP_DIR/current"
sudo systemctl daemon-reload
sudo systemctl enable --now "$APP_NAME"
for attempt in {1..20}; do if curl --fail --silent "http://127.0.0.1:$APP_PORT/api/health" >/dev/null; then break; fi; sleep 1; done
curl --fail --silent --show-error "http://127.0.0.1:$APP_PORT/api/health"
sudo tailscale serve --bg --https="$HTTPS_PORT" "http://127.0.0.1:$APP_PORT"
curl --fail --silent --show-error "https://$TAILSCALE_HOST:$HTTPS_PORT/api/health"
trap - ERR
echo
echo "$BRAND_NAME is available at https://$TAILSCALE_HOST:$HTTPS_PORT and https://${PUBLIC_HOSTS[0]}"
if sudo test -f "$DATA_DIR/setup-token"; then echo "Create your first Super User using the setup key at $DATA_DIR/setup-token (administrator access required)."; fi
echo 'Other services and installs on this server were not modified.'
