# Irish Hospital Supplies Cloud — working server application

The approved OCC interface connected to persistent SQLite metadata and file storage, real password authentication, and server-enforced permissions. This package is separate from the original Sites design prototype and from the other Irish Hospital Supplies applications.

## Run locally

Use Node 24 LTS (minimum supported runtime 22.13 with `node:sqlite`). No third-party runtime packages are required.

```sh
npm start
```

Visit http://127.0.0.1:3003. On first run, open `data/setup-token` locally and enter that key in the setup screen. Choose the first Super User's name, email and password. The key is single-use and removed after setup. No default user, sample files or shared demo passwords are installed.

The Super User creates accounts, assigns folder access and provides temporary passwords privately. New accounts and password resets require a password change on the next sign-in. Email invitations and password-reset emails are not configured; resets are handled by a Super User. Existing sessions expire after 12 hours, or after 30 minutes without activity. Deactivation, account-role changes and password resets invalidate sessions immediately.

## Two-step sign-in

Everyone signs in with their password and then a 6-digit code from an authenticator app (Google Authenticator, Microsoft Authenticator, 1Password and similar). At their first sign-in, each person scans a QR code, enters the code it shows and is given 10 one-time recovery codes to copy or print. A code can't be used twice; five wrong codes return to the password step, and ten wrong codes in 15 minutes block codes for that account for 15 minutes.

- **Lost phone:** sign in with a recovery code, or a Super User opens **User management → Edit** for that person and chooses **Reset authenticator**. They set it up again at their next sign-in. Super Users can't reset their own.
- **Super User locked out:** on the server run `sudo -u occcloud node /opt/occ-cloud/current/scripts/reset-mfa.mjs person@example.com /var/lib/occ-cloud`.
- **IHS Sync:** computers keep their connection keys. Connecting a new computer needs a signed-in browser session, so it is covered by the second step.
- Authenticator keys are encrypted with `MFA_ENCRYPTION_KEY` in `/etc/occ-cloud/occ-cloud.env`, which the deploy creates once. Keep a private copy of that file with the data backups and never change the key, or everyone has to set up their authenticator again. Outside production, a key is created in the data folder (`mfa-key`).

## Server layout

`deploy-server.sh` targets the existing Irish Hospital Supplies build/test server `serveradmin@192.168.0.248` using `~/.ssh/oxygen-care-server`. The key must be unlocked in your SSH agent. Deployment uses its own service and storage:

| Item | Location |
| --- | --- |
| Service | `occ-cloud` running as `occcloud` |
| Source releases | `/opt/occ-cloud/releases/` with `current` symlink |
| Metadata and file data | `/var/lib/occ-cloud/occ.sqlite` and `/var/lib/occ-cloud/blobs/` |
| Environment | `/etc/occ-cloud/occ-cloud.env` |
| Application listener | `127.0.0.1:3003` |
| Private HTTPS | `https://expenses.fynbos-spectrum.ts.net:8444` |
| Backups | `/var/backups/occ-cloud/` |

The deployment preflights the runtime and port, preserves an existing environment file and data, snapshots data before upgrades, and restores the previous source release if health verification fails. It configures only the new Tailscale HTTPS listener; Expense and Reports listeners are preserved. It does not install or upgrade shared system software. Run `bash deploy-server.sh`; the installer may request your usual sudo password in Terminal. Do not send passwords in chat.

The private server URL requires the existing Tailscale network. The first-run setup key stays in `/var/lib/occ-cloud/setup-token`, readable by the service user and administrators. The service is for the user's build/test environment; do not represent its private Tailscale URL as a public production host.

## Permissions and storage

- Super User: accounts, all folders, files and sharing.
- Viewer: view and download assigned folders and their contents.
- Contributor: Viewer access plus uploads and subfolder creation.
- Manager: Contributor access plus rename, move, delete and share within assigned folders.
- Top-level folder grants are inherited by all descendants. Moving items changes their access to the destination's access. New top-level folders start private. Only Super Users can create top-level folders or promote accounts.

Uploads accept arbitrary file types with a configurable 100 MB default per-file limit and 5 GB workspace quota. Two uploads may run concurrently, with one per account. Files are streamed to temporary storage and only published after validation. Duplicate names are rejected within each folder. Images and PDFs are previewed when recognised by their file signature; other types download as attachments. HTML and SVG are never rendered as active content. File and folder deletions are permanent.

This is a single-process application: use one application instance with its own persistent data volume. SQLite is appropriate for this build/test deployment and a modest single-instance host. Do not point multiple containers or replicas at the same directory. Larger or multi-instance deployments should migrate metadata to a server database and files to object storage before scaling.

Passwords use salted scrypt hashes. Sessions use hashed opaque tokens in the database and HTTP-only cookies, with Secure cookies in production. State-changing requests require the configured same-origin request and CSRF token. File content requests re-check access. Sign-in throttling and audit records persist across restarts. `TRUST_PROXY=1` is set only behind the local Tailscale proxy; omit it otherwise. Internal audit events live in the database; no audit UI is added.

## Back up and move to a host

On the test server, run:

```sh
sudo bash /opt/occ-cloud/current/scripts/backup-server.sh
```

The backup script briefly stops OCC for a consistent snapshot of metadata and blobs, writes a mode-600 archive and checksum, then restarts it. It does not stop other applications. Copy the archive, checksum and this source package to the new host over an authenticated connection. Keep backups private; they contain uploaded files and account password hashes. Backups are manual in this version; arrange scheduled backups and retention before production use.

To migrate:

1. Test a restore on the destination before the final transfer. Verify the archive checksum. Restore the whole archive into an **empty** data directory while OCC is stopped; preserve the `occ.sqlite` and `blobs/` relationship. Never copy only the database or copy a live SQLite file while writes are occurring.
2. Run `node scripts/verify-data.mjs /absolute/restored/data` to check database integrity and every stored file's size. Run `node scripts/expire-sessions.mjs /absolute/restored/data` so users sign in again on the new host.
3. Set `APP_ORIGIN` to the new exact HTTPS origin with no trailing slash, set `OCC_DATA_DIR` to the restored directory, and run Node behind the host's HTTPS reverse proxy. Grant the process read/write access only to its data directory. Retain the storage limits appropriate for that host.
4. For containers, copy `.env.example` to `.env`, set the real HTTPS origin and use `docker compose up -d --build`. Restore data into the `occ-data` named volume **before** starting the application; give the restored volume to UID/GID 1000 (the image's `node` user). A TLS reverse proxy must front the loopback-only port. Stop the container before restoring data.
5. Verify sign-in, user roles, uploads, downloads, a restart, and backups on the new host. For final cutover, stop writes on the old server, take the final backup, restore it and switch the URL. Leave the old instance stopped to avoid divergent files. Roll back to the old instance only before accepting new writes on the new host, or reconcile those writes first.

## Validation

`npm run check` performs syntax validation. `npm test` exercises actual HTTP endpoints and a temporary SQLite/file store, including persistence across restarts, role enforcement, CSRF, upload limits, content spoofing, account deactivation, permission revocation, password reset and database integrity. All test users and files are isolated from real data.

`test/browser.cjs` tests first-run setup, account creation, forced password change, uploads/downloads, refreshed-page persistence, sharing and mobile layout. Set `PLAYWRIGHT_PATH` and `CHROME_PATH` for your installed Playwright and Chrome when needed. Screenshots in `test-results/` are local test artifacts. Optional browser-agent tools from the design prototype are intentionally absent from the live application.

## Desktop sync preview

The schema-2 server adds **Desktop sync** account controls and `/api/sync/` endpoints for the sibling IHS Sync Mac/Windows app. Device keys are stored as SHA-256 hashes, expire after 90 days, and are revoked on password changes/resets or account deactivation. Every request rechecks account and folder access. Updates and downloads require an exact file revision; uploads calculate SHA-256 and updates increment revisions. Browser renames/moves also increment revisions.

This release migrates the database on startup. The remote installer saves a stopped-service backup before upgrading and restores matching data during rollback. Failed-release data is retained separately for recovery. Do not start an old server against a schema-2 database without restoring its matching backup.

Desktop apps are internal unsigned test builds. See the companion README for offline behavior, recovery files, and current folder/deletion limitations.

## Calendar diary

Calendar diary appears in the left navigation for every signed-in user after required password replacement. Calendar entries can be public (all signed-in OCC users), private (creator only), or assigned to one or more user groups. Owners can edit/delete their entries; Super Users can manage entries they can see, but cannot read another user’s private entries. Entries belong to the calendar rather than a file-sharing folder.

Book timed periods or all-day ranges (the form's last day is included). Dates/times use Europe/Dublin wall time on every device. Overlap checks reject conflicts with entries visible to the booking creator/editor; hidden private and group entries are not revealed by conflict responses. Adjacent periods are allowed. Edit/delete operations use revisions to reject stale changes. Notes and titles are escaped on display. Refresh reloads entries created by other users. This release does not include recurring events, reminders, external calendar integrations, or desktop calendar syncing.

Bookings are stored in the existing SQLite database in an additive `bookings` table and included in standard backups. The health response includes `calendar: true` when this release is running.

The calendar's right-hand panel lists all bookings overlapping the displayed year in date order, grouped by month. It scrolls independently for longer lists and opens the same booking details/edit form used for managing bookings. Changing months across a year boundary loads that year's list. On phones the annual list appears below the month grid, with date clicks opening a booking form.

Clicking a date opens the booking window with that date prefilled. Existing bookings open from the annual list; the daily side panel has been removed.

## Security baseline

See HARDENING.md for the October 2026 hardening changes, validation, and remaining hosting requirements. The health endpoint returns `hardening: 1` when that release is running. Legacy password hashes upgrade at successful sign-in; newly set passwords require at least 15 characters. Server runtime patching/reboots and off-server backup provisioning remain separate operational tasks.


## Workspace update — 2 October 2026

Uploads now appear at the top of Files. The root Files view shows folders; the Recent tab contains a compact, scrollable file list ordered by modification time. Opening a folder still shows its contents. Promotional and repeated explanatory copy has been removed.

Super Users manage calendar groups under User groups. Standard users can assign bookings only to their own groups. Membership changes take effect on the next request; already-viewed entries remain on a screen until refreshed. Existing bookings migrate as public to preserve their previous visibility. Private entries are creator-only at the application layer; server/database administrators can still access server storage. Group deletion is blocked while entries reference the group. Do not downgrade to a release without calendar-privacy enforcement against this database.

Repair Register was removed at the user's request before release. No repair endpoint, table creation or navigation is shipped.

## Message Board and In-tray

Message Board is available in the left navigation. Signed-in users can post coloured sticky notes and pin notes to the top. Notes are visible to the whole team; only the author or a Super User can edit or remove them. The board holds up to 300 notes, with revision checks to prevent overwriting concurrent edits.

Use **Notify someone** after an upload or from file details to send a file to selected users' In-trays. Only users who already have access can be selected. Each notification shows the sender, optional message and current folder path, with Open file and Open folder buttons. Sending does not grant access. When access is revoked or the file is removed, the notification no longer exposes its file details or message. Notifications are private to their recipient, including when the requester is a Super User.

The tray badge checks for unread notifications every 30 seconds while the page is visible without extending the idle session timeout. Notifications support read/unread controls and load older entries in batches of 100. Sending is limited to 50 recipients at once and 200 recipient notifications per hour. These are in-app notifications, not email or operating-system alerts. Refresh the board to see other users' notes.

Notes and notifications are stored in SQLite and included in existing backups. The health endpoint returns `updates: 1` for this release. Backend tests cover ownership, persistence, recipient isolation, access revocation and idle-session behaviour; browser tests cover sticky notes, file notifications, navigation and mobile layout.

## File locations — 10 October 2026

Host storage remains the default for uploads and drag-and-drop. **Add file location** offers Host storage, IHS Sync folder, and Existing file. Host storage opens the upload flow; the other choices save a reference with a name, OCC folder and absolute drive path. Supported path formats include `Z:\Shared\Manual.pdf`, `\\server\share\Manual.pdf`, `/Volumes/Work/Manual.pdf` and `/home/team/Manual.pdf`.

References appear in folder and Recent lists. Their details provide a copyable path, and they can be sent to another eligible user's In-tray. Browser pages cannot open local drive paths directly; copy the path into Finder or File Explorer on a computer with access to that location. A shared reference does not grant operating-system or network-drive access.

The IHS Sync option identifies a path in the desktop app's existing offline folder. Adding a reference does not configure the desktop app or create another sync job. References are never read by the server, uploaded, downloaded or included in desktop sync snapshots. Removing a reference or its OCC parent folder does not delete the original drive file. Drive paths are shared with users who can view the OCC folder; use folder permissions accordingly.

Contributors can add references; Managers and Super Users can edit/remove them. Changes use modification checks to prevent overwriting stale edits. The additive `file_references` table and reference notifications are covered by existing SQLite backups. Hosted blobs retain their existing storage layout. The health response includes `locations: 1`.
