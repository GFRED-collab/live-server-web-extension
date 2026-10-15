# Oxygen Care Expenses

A runnable, security-corrected replacement for the PDF prototype. Its only third-party runtime dependency is `sharp`, used to prepare receipt images.

## Run locally

1. Use Node 20.9 or newer (required by `sharp`); production should follow the Node.js version note in the checklist below.
2. Bootstrap the first Super User: `export SUPERUSER_EMAIL='admin@example.com'` and `export SUPERUSER_PASSWORD='a-unique-password-with-at-least-12-characters'`. This is the only role permitted to create regular users.
3. Local receipt OCR uses Tesseract (`OCR_PROVIDER=tesseract`), with [RapidOCR](https://github.com/RapidAI/RapidOCR) as a local failover when Tesseract can't read a receipt. The Ubuntu deploy installs RapidOCR in its own Python environment; locally, create one with `python3 -m venv .rapidocr && .rapidocr/bin/pip install -r scripts/rapidocr-requirements.txt` and set `RAPIDOCR_PYTHON=.rapidocr/bin/python3` (or `off` to skip it). Cloud receipt processing is disabled by default. Azure requires explicit `OCR_ALLOW_CLOUD=true` plus a server-only HTTPS endpoint and key; enabling it permits receipt images to leave the server, including as fallback after local OCR failure. PDFs remain manual attachments and are never sent to OCR. Never commit real credentials. See [security maintenance](SECURITY_MAINTENANCE.md) for deployment and privacy verification.
4. Start the app from a terminal with `npm start`.
5. Open `http://localhost:3000`, sign in as the Super User, then add regular users from the Super User panel.

### Reset a Super User password

Stop the server, then start it once with the existing Super User email and a new password:

```sh
export SUPERUSER_EMAIL='your-existing-super-user-email'
export RESET_SUPERUSER_PASSWORD='a-new-unique-password-with-at-least-12-characters'
node server.mjs
```

After the console confirms the reset, stop the server, clear `RESET_SUPERUSER_PASSWORD`, and start normally. This preserves regular users and expenses.

The manual expense workflow, filtering, per-user local durable storage, CSV export, and Euro totals work without OCR configuration. OCR works after the selected provider's configuration is available only to the server process. Sessions expire after 12 hours and also sign users out after 20 minutes of inactivity by default; users sign in again after a server restart. Every data-changing browser request requires a per-session CSRF token, and failed-login lockouts persist across restarts in `data/auth-failures.json`. Failed sign-ins and OCR events are recorded in `data/security-audit.log`. The active log rotates automatically at 10 MB into date-stamped archives, retaining the newest 12. Use `AUDIT_LOG_MAX_BYTES` and `AUDIT_LOG_ARCHIVES` in the server-only environment file to fit your retention policy, and protect these logs with the other data files.

Super Users can create Regular Users, Department Heads, and other Super Users; view a regular user's expenses; download that user's CSV export; and permanently delete a regular user together with their stored expense records. Expense records are held in the server's `data/expenses.json` file, rather than only in the browser.

Any signed-in user can select a date range from **Export**, then download the matching expenses as CSV or use **Print / Save PDF** to create a logo-headed printable PDF report.

When a user scans a JPEG, PNG, or WebP receipt, the image is saved only when the expense is saved. Attachments are stored privately in `data/receipts/`, outside the public web folder. Uploaded images are structurally checked and bounded by pixel dimensions; PDFs are parsed by `pdfinfo`, limited to 20 pages, and rejected if malformed or password protected. Total receipt storage is capped at 2 GiB by default and can be changed with `RECEIPT_STORAGE_MAX_BYTES`. The expense owner, a Super User, and the owner's Department Head can open an attached receipt; deleting the expense or its regular-user account also removes the stored image. PDF receipts are rendered as page images for an iPhone-safe in-app preview using `pdfinfo` and `pdftoppm` from `poppler-utils`; downloads always return the unchanged original PDF. Back up `data/` as one unit so receipt attachments and their expense records remain together.

## Production checklist

- Use only `./deploy-server.sh` for updates to the existing Ubuntu server. See
  `DEPLOY_UBUNTU.md`. The updater never transfers the live `data/` directory.

- Deploy behind HTTPS and set the selected OCR provider key in the platform's encrypted secret manager.
- Replace the JSON users, expenses, and odometer data store with a transactional database before using this for real financial records. Add password resets and MFA/SSO if required by your organisation.
- Maintain tested backups and a privacy/retention policy for receipt images. Built-in rate limits, persistent login lockouts, audit logging, CSRF protection, CSP/security headers, and receipt quotas are enabled by default.
- Restrict OCR usage with `OCR_RATE_LIMIT`, `OCR_DAILY_LIMIT`, `OCR_MAX_CONCURRENT`, and `OCR_TIMEOUT_MS`. The built-in defaults are deliberately conservative for a demo.
- Use a currently supported, security-patched Node.js LTS release. Node 22.23.2 is the minimum safe update from the previous server version 22.22.1.
- Confirm that Tesseract is installed and, if Azure fallback is configured, that the Azure resource endpoint and key are available only to the service account.
