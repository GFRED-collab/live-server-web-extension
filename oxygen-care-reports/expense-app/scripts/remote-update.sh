#!/usr/bin/env bash
set -Eeuo pipefail

APP_NAME="oxygen-care-expenses"
APP_DIR="/home/serveradmin/expense-ocr-app"
STAGE_DIR="/tmp/oxygen-care-expenses-release"
BACKUP_DIR="/home/serveradmin/oxygen-care-expenses-backups"
SYSTEMD_OVERRIDE_DIR="/etc/systemd/system/${APP_NAME}.service.d"
SYSTEMD_OVERRIDE="$SYSTEMD_OVERRIDE_DIR/security.conf"
NGINX_SITE="/etc/nginx/sites-available/$APP_NAME"
NGINX_RATE_LIMIT="/etc/nginx/conf.d/${APP_NAME}-rate-limit.conf"
TAILSCALE_HOST="expenses.fynbos-spectrum.ts.net"
# RapidOCR lives outside the release directory so backups and rollbacks leave it alone.
RAPIDOCR_VENV="/home/serveradmin/oxygen-care-expenses-rapidocr"
PADDLEOCR_VENV="/home/serveradmin/oxygen-care-expenses-paddleocr"
# PaddlePaddle only publishes packages for Python 3.9-3.13, but Ubuntu 26.04 ships 3.14.
# uv installs a private Python 3.13 for PaddleOCR and leaves the system Python alone.
PADDLEOCR_UV="/home/serveradmin/oxygen-care-expenses-uv"
PADDLEOCR_PYTHON_DIR="/home/serveradmin/oxygen-care-expenses-python"

[[ "$(id -un)" == "serveradmin" ]] || { echo "Run this update as serveradmin."; exit 1; }
[[ "$(systemctl show "$APP_NAME" -p User --value)" == "serveradmin" ]] || { echo "Service user does not match the approved deployment layout."; exit 1; }
[[ "$(systemctl show "$APP_NAME" -p WorkingDirectory --value)" == "$APP_DIR" ]] || { echo "Service directory does not match the approved deployment layout."; exit 1; }
[[ -f "$STAGE_DIR/server.mjs" && -f "$STAGE_DIR/public/app.js" && -f "$STAGE_DIR/package-lock.json" && -f "$STAGE_DIR/test/receipt-access.test.mjs" && -f "$STAGE_DIR/scripts/maintenance-cleanup.mjs" && -f "$STAGE_DIR/scripts/rapidocr_text.py" && -f "$STAGE_DIR/scripts/rapidocr-requirements.txt" && -f "$STAGE_DIR/scripts/paddleocr_text.py" && -f "$STAGE_DIR/scripts/paddleocr-requirements.txt" ]] || { echo "The staged release is incomplete."; exit 1; }
command -v node >/dev/null || { echo "Node.js is not installed on the server."; exit 1; }
command -v npm >/dev/null || { echo "npm is not installed on the server."; exit 1; }
command -v rsync >/dev/null || { echo "rsync is not installed on the server."; exit 1; }
command -v pdfinfo >/dev/null || { echo "pdfinfo is missing. Install poppler-utils before deployment."; exit 1; }
command -v pdftoppm >/dev/null || { echo "pdftoppm is missing. Install poppler-utils before deployment."; exit 1; }
command -v tailscale >/dev/null || { echo "Tailscale is required for private HTTPS access."; exit 1; }

node --check "$STAGE_DIR/server.mjs"
node --check "$STAGE_DIR/public/app.js"
sudo -v
sudo apt-get update
# libgl1 and libgomp1 are needed by PaddleOCR's image and maths libraries.
sudo apt-get install -y nginx tesseract-ocr tesseract-ocr-eng python3-venv libgl1 libgomp1
# Tesseract is the last local reader, after RapidOCR and PaddleOCR.
command -v tesseract >/dev/null || { echo "tesseract is missing. Install tesseract-ocr before deployment."; exit 1; }
tesseract --list-langs 2>/dev/null | grep -qx eng || { echo "Tesseract English data is missing. Install tesseract-ocr-eng before deployment."; exit 1; }
# RapidOCR is the default receipt reader. Install it and download its models now, while
# the service is still running: at runtime the service filesystem is read-only, so
# nothing can be downloaded then.
[[ -x "$RAPIDOCR_VENV/bin/python3" ]] || python3 -m venv "$RAPIDOCR_VENV"
"$RAPIDOCR_VENV/bin/pip" install --quiet --disable-pip-version-check -r "$STAGE_DIR/scripts/rapidocr-requirements.txt"
"$RAPIDOCR_VENV/bin/python3" -I -c 'from rapidocr import RapidOCR; RapidOCR()' >/dev/null 2>&1 || { echo "RapidOCR could not load its models. Check access to PyPI and www.modelscope.cn, then deploy again."; exit 1; }
# PaddleOCR is the fallback when RapidOCR cannot read a receipt. Reading one image here
# downloads its models into the environment. A failure only warns: scanning still works
# with RapidOCR and Tesseract, and the next deploy tries again.
paddleocr_environment() {
  if [[ -x "$PADDLEOCR_VENV/bin/python3" ]] \
    && "$PADDLEOCR_VENV/bin/python3" -I -c 'import sys; sys.exit(sys.version_info[:2] != (3, 13))'; then
    return 0
  fi
  # Missing, or made earlier with the system Python 3.14: rebuild it on Python 3.13.
  rm -rf "${PADDLEOCR_VENV:?}"
  if [[ ! -x "$PADDLEOCR_UV/bin/uv" ]]; then
    python3 -m venv "$PADDLEOCR_UV" \
      && "$PADDLEOCR_UV/bin/pip" install --quiet --disable-pip-version-check uv==0.13.1 || return 1
  fi
  UV_PYTHON_INSTALL_DIR="$PADDLEOCR_PYTHON_DIR" UV_PYTHON_PREFERENCE=only-managed "$PADDLEOCR_UV/bin/uv" -q python install 3.13 \
    && UV_PYTHON_INSTALL_DIR="$PADDLEOCR_PYTHON_DIR" UV_PYTHON_PREFERENCE=only-managed "$PADDLEOCR_UV/bin/uv" -q venv --seed --python 3.13 "$PADDLEOCR_VENV"
}
PADDLEOCR_READY=0
if paddleocr_environment \
  && "$PADDLEOCR_VENV/bin/pip" install --quiet --disable-pip-version-check -r "$STAGE_DIR/scripts/paddleocr-requirements.txt" \
  && PADDLEOCR_DOWNLOAD=1 "$PADDLEOCR_VENV/bin/python3" -I "$STAGE_DIR/scripts/paddleocr_text.py" <"$STAGE_DIR/public/oxygen-care-logo-supplied.jpeg" >/dev/null; then
  PADDLEOCR_READY=1
else
  echo "WARNING: PaddleOCR could not be installed or could not load its models. Check access to PyPI, github.com and huggingface.co. Receipt scanning will use RapidOCR and Tesseract only."
fi

# Back up a quiescent service. On failure restore code, never rewind live data.
BACKUP_READY=0
HAD_SECURITY_OVERRIDE=0
rollback() {
  trap - ERR
  sudo systemctl stop "$APP_NAME" || return 1
  if [[ "$BACKUP_READY" == "1" ]]; then
    echo "Update failed; restoring release $BACKUP_FILE (current data preserved)"
    tar -C "$APP_DIR" -xzf "$BACKUP_FILE" || return 1
    if [[ "$HAD_SECURITY_OVERRIDE" == "1" ]]; then
      sudo install -o root -g root -m 0644 "$PREVIOUS_OVERRIDE" "$SYSTEMD_OVERRIDE" || return 1
    else
      sudo rm -f "$SYSTEMD_OVERRIDE" || return 1
    fi
    sudo systemctl daemon-reload || return 1
  fi
  sudo systemctl start "$APP_NAME"
}
trap rollback ERR
sudo systemctl stop "$APP_NAME"
[[ "$(systemctl show "$APP_NAME" -p ActiveState --value)" == "inactive" ]] || { echo "Service did not stop safely."; exit 1; }

mkdir -p "$BACKUP_DIR"
chmod 0700 "$BACKUP_DIR"
BACKUP_FILE="$BACKUP_DIR/release-$(date -u +%Y%m%dT%H%M%SZ).tar.gz"
tar -C "$APP_DIR" --exclude='./data' -czf "$BACKUP_FILE" .
DATA_BACKUP_FILE="$BACKUP_DIR/data-$(date -u +%Y%m%dT%H%M%SZ).tar.gz"
tar -C "$APP_DIR/data" -czf "$DATA_BACKUP_FILE" .
chmod 0600 "$BACKUP_FILE" "$DATA_BACKUP_FILE"
tar -tzf "$BACKUP_FILE" >/dev/null
tar -tzf "$DATA_BACKUP_FILE" >/dev/null
PREVIOUS_OVERRIDE="$STAGE_DIR/security.conf.previous"
HAD_SECURITY_OVERRIDE=0
if sudo test -f "$SYSTEMD_OVERRIDE"; then
  sudo cp "$SYSTEMD_OVERRIDE" "$PREVIOUS_OVERRIDE"
  sudo chown "$(id -u):$(id -g)" "$PREVIOUS_OVERRIDE"
  HAD_SECURITY_OVERRIDE=1
fi

BACKUP_READY=1

rsync --archive --delete "$STAGE_DIR/public/" "$APP_DIR/public/"
rsync --archive --delete "$STAGE_DIR/test/" "$APP_DIR/test/"
install -m 0644 "$STAGE_DIR/server.mjs" "$APP_DIR/server.mjs"
install -d -m 0755 "$APP_DIR/scripts"
install -m 0644 "$STAGE_DIR/scripts/rapidocr_text.py" "$APP_DIR/scripts/rapidocr_text.py"
install -m 0644 "$STAGE_DIR/scripts/paddleocr_text.py" "$APP_DIR/scripts/paddleocr_text.py"
install -m 0644 "$STAGE_DIR/package.json" "$APP_DIR/package.json"
install -m 0644 "$STAGE_DIR/package-lock.json" "$APP_DIR/package-lock.json"
(cd "$APP_DIR" && npm ci --omit=dev --no-audit --no-fund)
(cd "$APP_DIR" && npm prune --omit=dev --no-audit --no-fund)
(cd "$APP_DIR" && node --test test/receipt-access.test.mjs)
"$RAPIDOCR_VENV/bin/python3" -I "$APP_DIR/scripts/rapidocr_text.py" <"$APP_DIR/public/oxygen-care-logo-supplied.jpeg" >/dev/null
if [[ "$PADDLEOCR_READY" == 1 ]]; then
  "$PADDLEOCR_VENV/bin/python3" -I "$APP_DIR/scripts/paddleocr_text.py" <"$APP_DIR/public/oxygen-care-logo-supplied.jpeg" >/dev/null
fi
# maintenance-cleanup.mjs is a separate, explicitly requested maintenance action.
# Do not mutate existing records or quarantine receipts during a code deployment.

# Keep the application reachable only through the HTTPS reverse proxy and turn
# on production-only cookie and HSTS protections. This drop-in is repeatable and
# leaves the original service file available for recovery.
cat >"$STAGE_DIR/security.conf" <<'SYSTEMD'
[Service]
TimeoutStopSec=90
Environment=HOST=127.0.0.1
Environment=NODE_ENV=production
UMask=0077
NoNewPrivileges=true
PrivateTmp=true
PrivateDevices=true
ProtectSystem=strict
ProtectHome=false
ProtectKernelTunables=true
ProtectKernelModules=true
ProtectKernelLogs=true
ProtectControlGroups=true
ProtectClock=true
ProtectHostname=true
ProtectProc=invisible
ProcSubset=pid
LockPersonality=true
RestrictSUIDSGID=true
RestrictRealtime=true
RestrictNamespaces=true
RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6
CapabilityBoundingSet=
AmbientCapabilities=
ReadWritePaths=/home/serveradmin/expense-ocr-app/data
SYSTEMD
sudo install -d -o root -g root -m 0755 "$SYSTEMD_OVERRIDE_DIR"
sudo install -o root -g root -m 0644 "$STAGE_DIR/security.conf" "$SYSTEMD_OVERRIDE"

# Tailscale terminates trusted HTTPS. Nginx remains loopback-only and provides
# request limits plus a narrow reverse-proxy boundary in front of Node.
cat >"$STAGE_DIR/nginx-rate-limit.conf" <<'NGINX_RATE'
limit_req_zone $binary_remote_addr zone=oxygen_expenses_api:10m rate=15r/s;
limit_conn_zone $binary_remote_addr zone=oxygen_expenses_connections:10m;
NGINX_RATE
cat >"$STAGE_DIR/nginx-site.conf" <<NGINX_SITE
server {
    listen 127.0.0.1:8080;
    server_name $TAILSCALE_HOST;
    client_max_body_size 15m;
    client_body_timeout 15s;
    client_header_timeout 15s;
    keepalive_timeout 15s;
    send_timeout 60s;
    server_tokens off;

    location / {
        limit_req zone=oxygen_expenses_api burst=30 nodelay;
        limit_conn oxygen_expenses_connections 20;
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto https;
        proxy_connect_timeout 10s;
        proxy_read_timeout 60s;
        proxy_send_timeout 60s;
    }
}
NGINX_SITE
sudo install -o root -g root -m 0644 "$STAGE_DIR/nginx-rate-limit.conf" "$NGINX_RATE_LIMIT"
sudo install -o root -g root -m 0644 "$STAGE_DIR/nginx-site.conf" "$NGINX_SITE"
sudo ln -sfn "$NGINX_SITE" "/etc/nginx/sites-enabled/$APP_NAME"
sudo rm -f /etc/nginx/sites-enabled/default
sudo nginx -t

# The app process needs private data access, but no other local account does.
chmod 0700 "$APP_DIR/data"
find "$APP_DIR/data" -type d -exec chmod 0700 {} +
find "$APP_DIR/data" -type f -exec chmod 0600 {} +

# These launchers belong to superseded local/provisioning workflows and must not
# remain callable on the production host.
rm -f "$APP_DIR/Start Oxygen Care.command" "$APP_DIR/deploy-ubuntu.sh"

sudo systemctl daemon-reload
sudo systemctl restart "$APP_NAME"
sudo systemctl enable --now nginx
sudo systemctl restart nginx
# Update only the expense listener. Other listeners (Reports on 8443) must survive.
sudo tailscale serve --bg --yes --https=443 http://127.0.0.1:8080
sleep 1
curl --fail --silent --show-error http://127.0.0.1:3000/ >/dev/null
curl --fail --silent --show-error -H "Host: $TAILSCALE_HOST" http://127.0.0.1:8080/ >/dev/null
[[ "$(systemctl show "$APP_NAME" -p Environment --value)" == *"HOST=127.0.0.1"* ]] || { echo "Production loopback binding was not applied."; exit 1; }
[[ "$(systemctl show "$APP_NAME" -p Environment --value)" == *"NODE_ENV=production"* ]] || { echo "Production mode was not applied."; exit 1; }
ss -ltn | grep -Eq '127\.0\.0\.1:3000\b' || { echo "The app is not listening on loopback port 3000."; exit 1; }
if ss -ltn | grep -Eq '(^|[[:space:]])(0\.0\.0\.0|\[::\]):3000\b'; then echo "Port 3000 is still exposed on a public interface."; exit 1; fi
sudo tailscale serve status | grep -Fq "$TAILSCALE_HOST" || { echo "Tailscale HTTPS was not configured."; exit 1; }
trap - ERR

find "$BACKUP_DIR" -type f \( -name 'release-*.tar.gz' -o -name 'data-*.tar.gz' \) -mtime +30 -delete
echo "Updated and hardened $APP_NAME successfully."
echo "Release backup: $BACKUP_FILE"
echo "Data backup: $DATA_BACKUP_FILE"
echo "Private HTTPS URL: https://$TAILSCALE_HOST"
