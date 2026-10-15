# Oxygen Care Expenses server updates

There is one supported deployment command for the existing Ubuntu server:

```bash
./deploy-server.sh
```

Run it from this `expense-app` directory on the Mac. It targets
`serveradmin@192.168.0.248` by default and validates that the live systemd
service still uses the approved `/home/serveradmin/expense-ocr-app` layout
before changing anything.

To target a replacement host explicitly:

```bash
SERVER_HOST=192.168.0.248 SERVER_USER=serveradmin ./deploy-server.sh
```

The updater:

- validates JavaScript and portable integrity tests on the Mac;
- runs the complete security and receipt suite on Ubuntu, where Poppler is used;
- recreates the disposable Ubuntu staging directory on every deployment so
  stale files cannot survive from older releases;
- verifies that `pdfinfo` and `pdftoppm` from `poppler-utils` are installed;
- installs Tesseract OCR (`tesseract-ocr`, `tesseract-ocr-eng`) and verifies the English language data, which receipt scanning needs;
- installs Nginx from Ubuntu's package repository;
- requests sudo authentication before modifying the live release;
- creates verified code and data rollback archives in
  `/home/serveradmin/oxygen-care-expenses-backups`;
- synchronises an allowlisted release and removes stale public assets;
- never uploads, overwrites, or deletes `data/`;
- removes superseded production-host launchers;
- restarts `oxygen-care-expenses` and performs a local HTTP health check;
- applies a repeatable systemd security override;
- changes the Node listener from all interfaces to `127.0.0.1`, so requests
  must pass through Nginx;
- enables production-only secure cookies and HSTS with `NODE_ENV=production`;
- changes the live data tree to owner-only directories and files;
- verifies that port 3000 is not exposed on a public interface;
- configures private trusted HTTPS through the server's existing Tailscale
  identity at `https://expenses.fynbos-spectrum.ts.net`;
- binds Nginx to `127.0.0.1:8080`, adds request/body limits, and keeps both
  Nginx and Node unavailable directly from the LAN;
- restores the previous release automatically if the update fails.

The app remains under the existing `serveradmin` account because moving its
live database and receipts to a new service identity is a separate migration.
The systemd sandbox substantially limits the process, but a later maintenance
window should move the service to a dedicated non-login account and place code
under `/opt` with root ownership.

Do not copy the app folder manually and do not run old provisioning or macOS
launcher scripts on the production host.

The iPhone or computer opening the app must be signed into the same Tailscale
network. After deployment, replace any old `http://192.168.0.248:3000`
bookmark with `https://expenses.fynbos-spectrum.ts.net` and add that HTTPS page to
the iPhone Home Screen again.
