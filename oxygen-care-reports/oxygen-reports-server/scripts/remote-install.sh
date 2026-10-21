#!/usr/bin/env bash
set -Eeuo pipefail

APP_NAME="oxygen-care-reports"
APP_USER="oxygenreports"
APP_DIR="/opt/oxygen-care-reports"
STAGE_DIR="/tmp/oxygen-care-reports-release"
ENV_DIR="/etc/oxygen-care-reports"
ENV_FILE="$ENV_DIR/oxygen-care-reports.env"
BACKUP_DIR="/home/serveradmin/oxygen-care-reports-backups"
NGINX_SITE="/etc/nginx/sites-available/$APP_NAME"
NGINX_LIMITS="/etc/nginx/conf.d/${APP_NAME}-limits.conf"
TAILSCALE_HOST="expenses.fynbos-spectrum.ts.net"
TAILSCALE_PORT="8443"
# Public address served through Cloudflare Tunnel, accepted alongside the Tailscale one.
PUBLIC_HOST="reports.kobalinesystems.com"
APP_PORT="3002"
PROXY_PORT="8081"
DB_NAME="oxygen_care_reports"
DB_USER="oxygen_reports"

[[ "$(id -un)" == "serveradmin" ]] || { echo "Run this installer as serveradmin."; exit 1; }
[[ -f "$STAGE_DIR/package-lock.json" && -f "$STAGE_DIR/app/page.tsx" && -f "$STAGE_DIR/database/schema.sql" ]] || { echo "The staged Reports release is incomplete."; exit 1; }
for command in node npm rsync tailscale; do command -v "$command" >/dev/null || { echo "$command is required."; exit 1; }; done

sudo -v
sudo apt-get update
sudo apt-get install -y nginx postgresql postgresql-client openssl

if ! id "$APP_USER" >/dev/null 2>&1; then sudo useradd --system --home-dir "$APP_DIR" --shell /usr/sbin/nologin "$APP_USER"; fi
sudo install -d -o "$APP_USER" -g "$APP_USER" -m 0750 "$APP_DIR"
install -d -m 0700 "$BACKUP_DIR"

if sudo test -f "$ENV_FILE"; then
  echo "Keeping the existing protected environment file."
else
  DB_PASSWORD="$(openssl rand -hex 32)"
  SESSION_SECRET="$(openssl rand -hex 48)"
  sudo install -d -o root -g "$APP_USER" -m 0750 "$ENV_DIR"
  {
    echo "NODE_ENV=production"
    echo "PORT=$APP_PORT"
    echo "HOSTNAME=127.0.0.1"
    echo "DATABASE_URL=postgresql://$DB_USER:$DB_PASSWORD@127.0.0.1:5432/$DB_NAME"
    echo "DATABASE_SSL=disable"
    echo "SESSION_SECRET=$SESSION_SECRET"
    echo "APP_URL=https://$TAILSCALE_HOST:$TAILSCALE_PORT"
    echo "NEXT_PUBLIC_APP_URL=https://$TAILSCALE_HOST:$TAILSCALE_PORT"
  } >"$STAGE_DIR/production.env"
  sudo install -o root -g "$APP_USER" -m 0640 "$STAGE_DIR/production.env" "$ENV_FILE"

  if ! sudo -u postgres psql -tAc "SELECT 1 FROM pg_roles WHERE rolname='$DB_USER'" | grep -q 1; then sudo -u postgres createuser "$DB_USER"; fi
  sudo -u postgres psql --set=db_password="$DB_PASSWORD" <<'SQL'
ALTER ROLE oxygen_reports WITH LOGIN PASSWORD :'db_password';
SQL
  if ! sudo -u postgres psql -tAc "SELECT 1 FROM pg_database WHERE datname='$DB_NAME'" | grep -q 1; then sudo -u postgres createdb --owner="$DB_USER" "$DB_NAME"; fi
fi
# Older settings files predate the public domain: add it without touching anything else.
if ! sudo grep -q '^APP_EXTRA_ORIGINS=' "$ENV_FILE"; then
  echo "APP_EXTRA_ORIGINS=https://$PUBLIC_HOST" | sudo tee -a "$ENV_FILE" >/dev/null
fi

set -a
# shellcheck disable=SC1090
source <(sudo cat "$ENV_FILE")
set +a

if sudo -u postgres psql -d "$DB_NAME" -tAc "SELECT to_regclass('public.users') IS NOT NULL" | grep -q t; then
  BACKUP_FILE="$BACKUP_DIR/database-$(date -u +%Y%m%dT%H%M%SZ).dump"
  sudo -u postgres pg_dump --format=custom "$DB_NAME" >"$BACKUP_FILE"
  chmod 0600 "$BACKUP_FILE"
  echo "Database backup: $BACKUP_FILE"
else
  psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f "$STAGE_DIR/database/schema.sql"
fi

if [[ -d "$APP_DIR/app" ]]; then
  RELEASE_BACKUP="$BACKUP_DIR/release-$(date -u +%Y%m%dT%H%M%SZ).tar.gz"
  sudo tar -C "$APP_DIR" --exclude='./node_modules' --exclude='./.next' -czf "$RELEASE_BACKUP" .
  sudo chown serveradmin:serveradmin "$RELEASE_BACKUP"
  chmod 0600 "$RELEASE_BACKUP"
  echo "Release backup: $RELEASE_BACKUP"
fi

sudo rsync --archive --delete \
  --exclude '.git' --exclude '.env' --exclude '.env.*' --exclude '.next' --exclude 'node_modules' --exclude 'tsconfig.tsbuildinfo' \
  "$STAGE_DIR/" "$APP_DIR/"
sudo chown -R "$APP_USER:$APP_USER" "$APP_DIR"
sudo -u "$APP_USER" npm --prefix "$APP_DIR" ci --no-audit --no-fund
sudo -u "$APP_USER" env DATABASE_URL="$DATABASE_URL" DATABASE_SSL=disable npm --prefix "$APP_DIR" run db:migrate
sudo -u "$APP_USER" npm --prefix "$APP_DIR" run check

cat >"$STAGE_DIR/$APP_NAME.service" <<SYSTEMD
[Unit]
Description=Oxygen Care Reports
After=network-online.target postgresql.service
Wants=network-online.target
Requires=postgresql.service

[Service]
Type=simple
User=$APP_USER
Group=$APP_USER
WorkingDirectory=$APP_DIR
EnvironmentFile=$ENV_FILE
ExecStart=/usr/bin/npm run start -- --hostname 127.0.0.1 --port $APP_PORT
Restart=on-failure
RestartSec=5
UMask=0077
NoNewPrivileges=true
PrivateTmp=true
PrivateDevices=true
ProtectSystem=strict
ProtectHome=true
ProtectKernelTunables=true
ProtectKernelModules=true
ProtectKernelLogs=true
ProtectControlGroups=true
LockPersonality=true
RestrictSUIDSGID=true
RestrictRealtime=true
RestrictNamespaces=true
RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6
CapabilityBoundingSet=
AmbientCapabilities=

[Install]
WantedBy=multi-user.target
SYSTEMD
sudo install -o root -g root -m 0644 "$STAGE_DIR/$APP_NAME.service" "/etc/systemd/system/$APP_NAME.service"

cat >"$STAGE_DIR/nginx-limits.conf" <<'NGINX_LIMITS'
limit_req_zone $binary_remote_addr zone=oxygen_reports_api:10m rate=15r/s;
limit_conn_zone $binary_remote_addr zone=oxygen_reports_connections:10m;
NGINX_LIMITS
cat >"$STAGE_DIR/nginx-site.conf" <<NGINX_SITE
server {
    listen 127.0.0.1:$PROXY_PORT;
    server_name $TAILSCALE_HOST $PUBLIC_HOST;
    client_max_body_size 20m;
    server_tokens off;
    # Cloudflare Tunnel connects from this machine and passes the visitor's address in
    # CF-Connecting-IP; use it so rate limits apply per visitor, not to everyone at once.
    set_real_ip_from 127.0.0.1;
    set_real_ip_from ::1;
    real_ip_header CF-Connecting-IP;

    location / {
        limit_req zone=oxygen_reports_api burst=30 nodelay;
        limit_conn oxygen_reports_connections 20;
        proxy_pass http://127.0.0.1:$APP_PORT;
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
sudo install -o root -g root -m 0644 "$STAGE_DIR/nginx-limits.conf" "$NGINX_LIMITS"
sudo install -o root -g root -m 0644 "$STAGE_DIR/nginx-site.conf" "$NGINX_SITE"
sudo ln -sfn "$NGINX_SITE" "/etc/nginx/sites-enabled/$APP_NAME"
sudo nginx -t

sudo systemctl daemon-reload
sudo systemctl enable --now postgresql nginx "$APP_NAME"
sudo systemctl restart "$APP_NAME" nginx
sudo tailscale serve --bg --yes --https="$TAILSCALE_PORT" "http://127.0.0.1:$PROXY_PORT"

sleep 3
curl --fail --silent --show-error "http://127.0.0.1:$APP_PORT/api/health" | grep -q '"ok":true'
curl --fail --silent --show-error -H "Host: $TAILSCALE_HOST" "http://127.0.0.1:$PROXY_PORT/api/health" | grep -q '"ok":true'
ss -ltn | grep -Eq "127\\.0\\.0\\.1:$APP_PORT\\b"
if ss -ltn | grep -Eq "(^|[[:space:]])(0\\.0\\.0\\.0|\[::\]):$APP_PORT\\b"; then echo "Reports port is exposed publicly."; exit 1; fi
sudo tailscale serve status | grep -Fq ":$TAILSCALE_PORT"

if ! sudo -u postgres psql -d "$DB_NAME" -tAc "SELECT 1 FROM users WHERE role='super_user' LIMIT 1" | grep -q 1; then
  echo
  echo "Create the first Reports Super User."
  read -rp "Super User email: " ADMIN_EMAIL
  read -rsp "Super User password (12+ characters): " ADMIN_PASSWORD
  echo
  sudo -u "$APP_USER" env DATABASE_URL="$DATABASE_URL" npm --prefix "$APP_DIR" run db:bootstrap-super-user -- --email "$ADMIN_EMAIL" --password "$ADMIN_PASSWORD"
fi

find "$BACKUP_DIR" -type f \( -name 'release-*.tar.gz' -o -name 'database-*.dump' \) -mtime +30 -delete
echo "Reports deployment is healthy."
echo "Private URL: https://$TAILSCALE_HOST:$TAILSCALE_PORT"
echo "The Expense App remains available on the existing port-443 URL."
