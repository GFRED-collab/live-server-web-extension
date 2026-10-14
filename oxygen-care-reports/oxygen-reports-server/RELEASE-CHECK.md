# Pre-deployment audit — 6 October 2026

## Confirmed findings fixed

- Stock import is present only inside Stock; the retired sidebar event bridge and its styling are gone.
- Failed logout and post-signature refresh callbacks are caught and surfaced. Fieldwork handles non-JSON gateway errors without leaking JSON parse exceptions.
- Denied contract/device/service requests roll back before releasing database clients. Invalid fitted-part input is rejected before opening a connection.
- Fitted-part creation checks device/contract/client membership and servicing-date membership. Service edits lock the visit; finalized visits reject edits. Fitted-part deletion and audit write are transactional.
- Stock imports reject malformed/empty/oversized batches, invalid quantities and duplicate part numbers before acquiring a database client.
- Docker build inputs exclude local environment files, credentials, dependencies and generated output. Release transfer excludes Git and environment variants.
- Bootstrap argument handling and bcrypt password-byte bounds are consistent. Deployment guidance no longer describes the app as an unconnected prototype.
- Deployment now runs all route regression checks before transfer; npm test is the single test entry point. Existing migration, bootstrap and deployment scripts are retained because they perform different required jobs.

## Verification scope

Production build, TypeScript/unused-code checks, all route regressions, shell syntax checks and dependency audit are exercised locally. Browser checks cover Stock import, login/logout, calendar ranges, report field editing/removal/restoration, CSV preview/download, machine history, branded printing, overnight dockets/signatures and responsive layouts, including simulated failed logout.

Route tests use simulated database responses; browser workflow tests use simulated API data. These checks do not replace live database, Docker runtime, reverse-proxy or host acceptance tests. No server changes or deployment are included in this audit.

Follow HARDENING.md for remaining host controls: exact HTTPS APP_URL, protected database/network access, shared/persistent login rate limiting, backups/restore tests and a separately tested stricter script CSP. Current login throttling remains process-local. This is a security baseline, not certification or a guarantee of no defects.
