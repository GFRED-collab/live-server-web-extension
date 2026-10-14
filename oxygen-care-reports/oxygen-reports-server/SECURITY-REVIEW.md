# Security review — 9 October 2026

## Session hardening — 11 October 2026

- Server authentication rejects sessions after 15 minutes without explicit activity and after eight hours from creation, whichever occurs first. Existing sessions are subject to these checks after deployment.
- Ordinary requests, including notifications and session polling, never update idle time. A same-origin POST activity endpoint renews only still-valid sessions using a conditional database update; expired sessions cannot be revived.
- The browser sends rate-limited activity only for trusted pointer, keyboard and scroll events while visible. It checks session status without renewal, clears rendered content and returns to login on timeout. Network waits are bounded. Multiple tabs consult the shared server expiry.
- Closing a tab/window is deliberately not a logout trigger. Cookie persistence remains unchanged apart from the eight-hour maximum.
- Downloaded/exported documents and standalone generated print windows are copies; session expiration cannot retract their contents. Device/browser access controls remain necessary.
- Successful login creates a fresh random token and revokes the previous cookie's session. Tokens remain hashed in the database; production cookies remain Secure, HttpOnly and SameSite=Strict. Password reset session revocation and same-origin write checks remain in place.
- SQL boundary and polling regressions simulate database responses. A browser acceptance test uses a shortened mocked server expiry, not a live 15-minute production test. Live server acceptance remains necessary.
- These session controls follow the OWASP session-management approach, not a claim of complete compliance or certification. Shared login throttling, MFA, script-policy tightening and the previously identified signature race still need dedicated work.

Reference: [OWASP Session Management Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Session_Management_Cheat_Sheet.html).

## Changes verified locally

- Workbook uploads are limited to 5 MiB, ZIP members to 20 MiB after streaming decompression, and archive entries to 2,000. Declared sizes are not trusted: actual decompressed bytes are counted.
- Spreadsheet XML rejects document/entity declarations and parser errors. Worksheet relationships are selected by attribute comparison, not a regular expression built from uploaded content. External and traversal-style worksheet targets are rejected.
- Imports reject more than 50,000 rows, 1,024 columns or 200,000 cells. No uploaded workbook code, macros or formulas are executed by the importer.
- Repair CSV exports use the shared formula-prefix protection, including leading whitespace. CSV formula handling is not a guarantee when a spreadsheet application rewrites and reopens a file.
- Branded print windows detach their opener, request no referrer and restrict subsequent resource loads with a print-specific content policy. Existing output escaping remains necessary; a policy added after document creation is not a substitute for escaping.
- A malicious-input regression is included in `npm test`, covering corrupt archives, forged sizes, a compressed expansion bomb and CSV formula prefixes.
- Next.js was updated from 16.3.6 to 16.4.0 using the compatible dependency update. The full test suite, TypeScript check and production build pass; the final npm audit reports zero known vulnerabilities.

## Verification boundaries and remaining work

- Database regression tests simulate database responses; they do not verify production PostgreSQL permissions, backups, restoration, concurrent transactions or server configuration.
- Login throttling is process-local; shared enforcement across restarts and multiple instances remains outstanding.
- The main application content policy still needs a nonce-based script policy and browser compatibility testing.
- Service-visit signature saving checks finalized status before writing without a transaction-level row lock. Concurrent finalization/signing needs a dedicated fix and concurrency regression; this review has not changed that workflow.
- Live TLS/Tailscale, firewall rules, operating-system updates, secret handling, log retention and account access require a server-side review. No server deployment was performed by this review.
- Dependency audit results are point-in-time advisories, not proof that dependencies are trustworthy. Package lifecycle scripts remain part of installation and must only run from a reviewed source and lockfile.
- A headless Chrome check passed for print-window opener isolation, referrer/content policies, embedded logo loading and the Close callback. Malformed-XML import handling still needs end-to-end browser coverage; the unit tests cover the ZIP reader, not that UI path.

References: [OWASP file upload guidance](https://cheatsheetseries.owasp.org/cheatsheets/File_Upload_Cheat_Sheet.html), [OWASP CSV injection guidance](https://community.owasp.org/attacks/CSV_Injection).
