#!/usr/bin/env bash
set -Eeuo pipefail

# Run this script from the Oxygen Care Reports project folder on your Mac.
# It deploys the current source to Ubuntu using the supplied SSH account.
SERVER_HOST="${SERVER_HOST:-192.168.0.248}"
SERVER_USER="${SERVER_USER:-serveradmin}"
APP_NAME="oxygen-care-reports"
APP_USER="oxygenreports"
APP_DIR="/opt/${APP_NAME}"
SERVER_NAME="${SERVER_NAME:-${SERVER_HOST}}"

PROJECT_DIR="$(cd "$(dirname "$0")" && pwd)"

if ! command -v rsync >/dev/null; then
  echo "rsync is required on this Mac. Install it, then run this script again."
  exit 1
fi

echo "Copying the application source to ${SERVER_USER}@${SERVER_HOST}..."
rsync --archive --compress \
  --exclude '.DS_Store' \
  --exclude '.env' \
  --exclude '.env.local' \
  --exclude '.next' \
  --exclude 'node_modules' \
  --exclude 'tsconfig.tsbuildinfo' \
  "${PROJECT_DIR}/" "${SERVER_USER}@${SERVER_HOST}:/tmp/${APP_NAME}-release/"

echo "Installing and configuring the server application..."
ssh -tt "${SERVER_USER}@${SERVER_HOST}" \
  "APP_NAME='${APP_NAME}' APP_USER='${APP_USER}' APP_DIR='${APP_DIR}' SERVER_NAME='${SERVER_NAME}' bash -s" <<'REMOTE_SCRIPT'
set -Eeuo pipefail

sudo apt-get update
sudo apt-get install -y nginx curl

if ! id "$APP_USER" >/dev/null 2>&1; then
  sudo useradd --system --create-home --home-dir "/var/lib/$APP_NAME" --shell /usr/sbin/nologin "$APP_USER"
fi

sudo install -d -o "$APP_USER" -g "$APP_USER" -m 0750 "$APP_DIR"
sudo cp -a "/tmp/${APP_NAME}-release/." "$APP_DIR/"
sudo chown -R "$APP_USER:$APP_USER" "$APP_DIR"

NPM_BIN="$(command -v npm)"
if [[ -z "$NPM_BIN" ]]; then
  echo "npm is not available on the server."
  exit 1
fi

sudo -u "$APP_USER" env HOME="/var/lib/$APP_NAME" "$NPM_BIN" --prefix "$APP_DIR" ci
sudo -u "$APP_USER" env HOME="/var/lib/$APP_NAME" "$NPM_BIN" --prefix "$APP_DIR" run build

sudo install -d -m 0750 /etc/oxygen-care-reports
sudo tee /etc/oxygen-care-reports/oxygen-care-reports.env >/dev/null <<'ENV_FILE'
NODE_ENV=production
PORT=3000
HOSTNAME=127.0.0.1
ENV_FILE
sudo chmod 0640 /etc/oxygen-care-reports/oxygen-care-reports.env
sudo chown root:"$APP_USER" /etc/oxygen-care-reports/oxygen-care-reports.env

sudo tee "/etc/systemd/system/${APP_NAME}.service" >/dev/null <<SERVICE_FILE
[Unit]
Description=Oxygen Care Reports
After=network.target

[Service]
Type=simple
User=$APP_USER
Group=$APP_USER
WorkingDirectory=$APP_DIR
EnvironmentFile=/etc/oxygen-care-reports/oxygen-care-reports.env
ExecStart=$NPM_BIN run start -- -H 127.0.0.1 -p 3000
Restart=on-failure
RestartSec=5
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=full
ReadWritePaths=$APP_DIR /var/lib/$APP_NAME

[Install]
WantedBy=multi-user.target
SERVICE_FILE

sudo tee "/etc/nginx/sites-available/${APP_NAME}" >/dev/null <<NGINX_FILE
server {
    listen 80;
    listen [::]:80;
    server_name $SERVER_NAME;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
    }
}
NGINX_FILE

sudo ln -sfn "/etc/nginx/sites-available/${APP_NAME}" "/etc/nginx/sites-enabled/${APP_NAME}"
sudo nginx -t
sudo systemctl daemon-reload
sudo systemctl enable --now "$APP_NAME"
sudo systemctl restart nginx

# Only Nginx is public. Next.js remains bound to localhost:3000.
sudo ufw allow 'Nginx Full'
sudo ufw status

sleep 2
systemctl --no-pager --full status "$APP_NAME"
curl --fail --silent --show-error http://127.0.0.1:3000/ >/dev/null
echo "Server health check passed."
REMOTE_SCRIPT

echo "Deployment complete: http://${SERVER_NAME}"
echo "HTTPS needs a DNS name and certificate. See DEPLOY_UBUNTU.md for the final HTTPS step."
