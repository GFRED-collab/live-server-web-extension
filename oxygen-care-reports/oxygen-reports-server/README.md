# Oxygen Care Reports — Server Package

This is the active Oxygen Care Reports application. It uses PostgreSQL for operational data and runs on port 3002 in the server deployment.

## Call-out and docket lookups

The top-of-page Lookup tab contains the search controls; the entry tab contains the form and register. Switching tabs preserves entered details and the selected call-out link.

Call-outs and completion dockets have searchable client/device lookups. Super Users can search the directory; other users see clients on assigned contracts and active devices on assigned contracts. Manual entry remains available. Dockets can select and search visible call-outs to copy client/location/device details; the reported issue is shown separately and is not copied into completed work. Selecting a lookup clears any drawn signature. Migration `015-callout-device-details.sql` adds device/serial snapshots to call-outs; older call-outs keep blank device fields unless corrected.

## Device history

Contracts exposes Open service in its top navigation, alongside a visit selector. The first visit is the default; the selector retains a valid selected visit when returning through the Contracts tab. Repeated Open service links have been removed from the service-history rows. Contracts without visits show the tab disabled.

Machine history presents audit changes with readable labels and keeps technical details collapsed and excluded from printouts. Report-row edits record field names and before/after values in the same database transaction as the update. Older events without these values are explicitly labelled as unavailable. Technical audit events remain restricted to Super Users by the machine-history API.

## Text-entry policy

Manage Entries deletion sends identifiers and a reason, not editable field values. Legacy delete payloads have their unused `fields` discarded before emoji validation, so existing emoji entries can be removed while the new audit reason remains validated. Authorization, stale-version checks, linked-record protections and preservation of the database original still apply.

Application API writes reject emojis in text values and field names, including appointments, repairs, call-outs, reports, stock, users, custom fields and admin edits. Nested CSV/XLSX import rows are validated before database access; an invalid batch is rejected rather than silently altered. The UI displays the validation error when saving. International text, accented names, ordinary punctuation and numbers remain supported. Genuine top-level passwords on login and user-management endpoints are exempt; a report column named `password` is not exempt. Existing records are not rewritten or deleted by this validation change.

## Included

- PostgreSQL database schema for accounts, departments, custom fields, reports, assignments, rows, parts stock and permanent activity logs.
- Docker configuration for an app service and local PostgreSQL instance.
- A database health endpoint at `/api/health`.
- A secure password-hashed Super User bootstrap command.
- Environment-variable templates for database, session, email, file storage and MFA encryption values.
- PostgreSQL-backed API routes for sign-in/sign-out sessions, users, field permissions, reports, report assignments and rows, warehouse stock, stock movements, and the permanent activity feed.

## Local preparation

1. Copy `.env.example` to `.env.local` and replace every placeholder.
2. Start PostgreSQL with `docker compose up -d database`, or use an existing PostgreSQL 16 database and apply `database/schema.sql`.
3. Run `npm install` and `npm run dev`; the server package opens at `http://localhost:3002` when launched with `Start Oxygen Care Reports Server.command`.
4. Confirm the database connection at `http://localhost:3002/api/health`.
5. Bootstrap the first administrator:

   `npm run db:bootstrap-super-user -- --email admin@your-domain.example --password "a-long-unique-password"`

## Hosting handover

For a hosted environment, provision managed PostgreSQL, object storage for original spreadsheet files, an SMTP service, and a secret manager. Set the production values through the host’s environment controls. Run the database schema once, bootstrap the first Super User once, then deploy the application container.

## Important scope note

The application provides authenticated reports, users and permissions, clients, contracts, service visits, appointments, stock control and a repair registry. The former prototype login and simulated MFA/reset screens have been removed. Audit records remain stored in PostgreSQL; the Activity Log screen is no longer part of the interface. Print previews use the shared Oxygen Care branded form layout.

## API milestone

Stock CSV/XLSX import is in the Stock page, not the sidebar. This release adds a request-security baseline and a patched production dependency. Before deploying, follow [HARDENING.md](HARDENING.md), especially setting APP_URL to the exact browser-facing origin. Run `node scripts/check-hardening.cjs` alongside the existing regression scripts.

Warehouse parts have an optional Location field, saved and displayed in the stock list. Apply migration 013 before running this version; imports without a location preserve any existing location.

Migration 014 hides report hours fields (historical values are retained) and replaces the service checkbox with Service status throughout Reports and contract servicing. Super Users add dropdown options in Contracts → Service status options. Initial options are Not serviced, Serviced and Follow-up required. Reports filter this status by exact match. Existing signed originals remain unchanged.

All mutation routes require an authenticated HTTP-only session and write permanent audit records. Super User authorization protects account, permission, report administration, and audit-feed operations; Warehouse Users can manage stock; Engineers can record use of their own assigned stock. Run `npm run lint` and `npm run build` for local source validation.

### Completed interface integration

- Real email/password verification against PostgreSQL password hashes
- HTTP-only session creation, restoration, inactivity expiry, and logout
- Generic invalid-credential responses and a 15-minute sign-in attempt limit
- Role-aware session identity; non-Super Users cannot enter the administration workspace

### Reports workspace and corrections

Contracts opens in a focused browser with search/status filtering. Super Users have separate New contract and Report tools views. A selected contract has Overview, Devices and Service visits navigation; switching to tools preserves the selected contract and section. The app sidebar remains available throughout.

Report upload and layout tools share one section in Contracts. Opening a contract fills the upload client and assigned users. The Reports tab retains the imported report register and exports. Clients use compact rows; client and contract lists print the current search, and contracts and repairs offer All/Open/Closed filters.

All print previews use portrait A4, Courier typewriter text, the Oxygen Care logo, and no table rules. Longer documents continue onto additional A4 pages.

Super Users can use Manage entries to correct or delete call-outs, clients, repairs, appointments, contracts, devices, reports and report rows, service visits and device records, fitted-part records, dockets, stock parts and stock movements. User-account and field-permission controls remain in Users. Every admin correction/deletion requires a reason, saves the original in Preserved originals, records an audit event, and rejects stale edits. Deletion is blocked while other entries reference the record; it does not cascade through linked business history.

Correcting a service visit preserves its complete signed snapshot and reopens it as a draft requiring fresh signatures. Correcting a docket preserves its original signature and marks the current docket unsigned until the customer signs the corrected details. Stock movement quantity corrections/deletions adjust stock balances in the same transaction and reject changes that would make a balance negative.

Appointments support inclusive start/end dates and appear on every booked day, including ranges crossing months. Report field labels and types can be edited, and every field can be removed. Removal hides the field without deleting historical values; immutable storage keys preserve values and permissions when labels change.

Reports Export CSV opens a paginated preview of the current filtered rows and columns before an explicit download. Machine-register rows open a separate machine-history window with permission-scoped report records, service visits and fitted parts, repairs, and customer dockets. Matching uses linked device records or serial/asset identifiers with client identity, never model names alone. Super Users can also inspect audit events and preserved originals.

The login screen contains only the logo and sign-in form. New customer dockets require Time started and Time ended, support overnight work, and include both times in the branded printout. Older dockets without recorded times remain valid. Correcting signed docket details continues to require fresh customer sign-off.

Calendar appointments a Super User assigns to an engineer wait for the engineer's reply (migration 021). The engineer sees a count on the Calendar menu item and an "Appointments assigned to you" panel on the calendar, and can accept or reject; rejecting requires a reason. The Super User sees the reply and reason on the appointment, and the Calendar count shows upcoming rejected appointments until they are reassigned, moved or deleted. Moving or reassigning an appointment asks the engineer again.

Apply all migrations with `npm run db:migrate` before running this release. Migration 010 adds administrative history and docket correction status; 011 adds booking ranges and stable report-field identity; 012 adds docket work times. Apply earlier pending migrations, including 009, in sequence. The migration command requires DATABASE_URL in its environment. Verification includes `npm run check`, `node scripts/check-reports-enhancements.cjs`, `node scripts/check-admin-entries.cjs`, `node scripts/check-regressions.cjs`, and `node scripts/check-fieldwork.cjs`. These route regressions use simulated database responses; production database acceptance must follow deployment.

## Two-step sign-in

After the password, staff enter a code from an authenticator app (Google Authenticator, Microsoft
Authenticator, 1Password); customers enter a 6-digit code sent to their email.

- Staff set up their authenticator at their first sign-in after this release: they scan a QR code
  and receive ten one-time recovery codes. A Super User can reset someone's authenticator from
  **Users → Reset authenticator** (they are signed out and set it up again). If no other Super User
  is available, run `scripts/reset-mfa.mjs --email person@example.com` on the server with the
  production environment loaded.
- Five wrong codes return to the password step; ten per person in 15 minutes block codes for 15
  minutes. Email codes expire after 10 minutes and can be re-sent once a minute, four times.
- `MFA_ENCRYPTION_KEY` encrypts the authenticator keys. The deploy script creates it once; never
  change it, or every staff member must set up their authenticator again.
- Customer codes need `SMTP_URL` and `MAIL_FROM` in the server environment (see `.env.example`).
  Until they are set, customers cannot sign in; the deploy prints a note.
