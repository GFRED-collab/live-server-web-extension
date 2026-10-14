# Private Reports server deployment

The Reports package is prepared for the existing Ubuntu server at `192.168.0.248`. It runs alongside the Expense App without changing the Expense App service or its existing Tailscale HTTPS route.

## Resulting layout

- Application: `/opt/oxygen-care-reports`
- Service account: `oxygenreports`
- PostgreSQL database: `oxygen_care_reports`
- Protected environment: `/etc/oxygen-care-reports/oxygen-care-reports.env`
- Node/Next.js: `127.0.0.1:3002`
- Nginx proxy: `127.0.0.1:8081`
- Private Tailscale URL: `https://expenses.fynbos-spectrum.ts.net:8443`
- Backups: `/home/serveradmin/oxygen-care-reports-backups`

The Expense App remains at `https://expenses.fynbos-spectrum.ts.net` on the normal HTTPS port.

## First transfer

From this directory on the Mac, run:

```bash
./deploy-server.sh
```

The script validates and builds the project locally before transferring source files. On the server it requests the server administrator password because PostgreSQL, Nginx, the system account, and systemd service require administrative setup.

On the first deployment only, it also asks for the initial Reports Super User email and a password of at least 12 characters. The password is passed directly to the bootstrap process and is not written to the deployment staging directory.

## Repeat deployments

Use the same command. Existing database credentials and data are retained. Before replacing a release, the installer creates:

- a PostgreSQL custom-format database dump;
- a source release archive, excluding dependencies and build output.

Backups older than 30 days are removed after a successful deployment.

## Security boundaries

- PostgreSQL is not exposed to the LAN or tailnet.
- Next.js and Nginx listen on loopback only.
- Tailscale terminates private HTTPS on port 8443.
- The application runs as a dedicated unprivileged account under a hardened systemd unit.
- Secrets are generated on the server and stored in a root-owned environment file.
- The local PostgreSQL connection explicitly disables transport SSL because it never leaves loopback; remote managed databases default to certificate verification.
- The existing Tailscale port-443 configuration is not reset.

## Acceptance checks

The installer stops on failure and verifies:

- TypeScript and production build;
- PostgreSQL health through `/api/health`;
- Nginx proxy health;
- loopback-only application binding;
- Tailscale Serve registration on port 8443.

The active Reports application is PostgreSQL-backed, including users, permissions, reports, contracts, service visits, stock, clients, appointments, repair entries, call-outs and dockets. Audit records remain stored; there is no separate Activity Log screen.

Before publishing this release, follow HARDENING.md and confirm APP_URL matches the browser-facing HTTPS origin. Keep both Tailscale routes registered: port 443 for Expenses and port 8443 for Reports. Never use `tailscale serve reset` to repair one application's route.
