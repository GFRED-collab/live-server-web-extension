# Security maintenance

## Changes prepared locally

- Sharp pinned to 0.35.5; unsupported SVG decoding explicitly disabled.
- Report CSV exporters share formula-neutralisation logic. Treat exported files as
  text data; spreadsheet save/reopen behaviour varies, so do not remove protective prefixes.
- Existing state-changing request queue verified; this is a single-process safeguard,
  not a transactional database or a cross-process lock.
- SIGTERM drains requests and audit writes before exit.
- Deployment stops the service before taking backups and installing files. Expect
  downtime during deployment. Automatic rollback restores code, never older data.
- Receipt/history cleanup is no longer an automatic deployment side effect.
- Azure OCR requires OCR_ALLOW_CLOUD=true in addition to its endpoint and key.
  Default is local-only, even if old Azure credentials remain configured.
  Cloud requests require HTTPS and do not follow redirects.

## Live work still required

SSH authentication prevented verification or migration of the running service.
Do not claim the server account is isolated until the following has been completed:

1. Verify the live service unit, override files, Node executable, data directory,
   environment-file location, ownership and existing backup access.
2. Take and restore-test an off-server backup.
3. During a maintenance window, stop the service; create a dedicated system account
   with a nologin shell and no sudo or administrator groups.
4. Put root-owned code under /opt and account-owned private data under /var/lib.
   Keep environment secrets outside the code. Do not grant traversal of the
   administrator home as a shortcut.
5. Update the service and deployment layout together, including backup permissions,
   read-only code, restricted writable paths and rollback.
6. Test login, upload, receipt viewing, OCR, approval, reimbursement, persistence,
   both sites' HTTPS routes, and restart behaviour before retiring the old layout.

The updater intentionally still validates the existing layout. It must not be used
unchanged after a manual service-account migration.

## OCR privacy verification

Inspect the effective service environment without copying secret values into logs.
Confirm whether OCR_ALLOW_CLOUD is unset/false or explicitly true. If true, verify
the approved Azure resource, region, retention and organisational processing policy.
Exercise a failed local scan and confirm it stays local when cloud processing is off.
No production OCR configuration has been verified by these local tests.

## Remaining limitations

JSON files are not an atomic multi-file transaction: a crash between user and expense
writes can leave a partial reimbursement. Moving to transactional storage remains
a separate data migration. Backups in the deployment script are local tar archives,
not encrypted off-server recovery copies. Recovery testing and a safe service-account
migration require live administrator access.
