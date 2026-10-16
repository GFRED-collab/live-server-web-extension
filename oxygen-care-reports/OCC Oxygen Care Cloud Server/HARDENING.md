# OCC security baseline — 1 October 2026

Scope: OCC application and its own Linux service. This is a code/configuration review and regression-tested hardening release, not an independent penetration test or certification. Changes below become active only after the staged release is installed.

## Existing protections verified

- OCC listens on loopback port 3003 and is served over HTTPS through private Tailscale port 8444.
- Production session cookies are Secure, HttpOnly, SameSite=Strict and use the __Host- prefix. Session tokens and desktop keys are hashed in the database. Sessions have 30-minute idle and 12-hour absolute expiry.
- Browser mutations require a matching Origin and CSRF token. No credentialed cross-origin API access is enabled.
- Server-side folder privileges, forced temporary-password replacement, password-reset/deactivation revocation, version-aware sync writes, parameterized SQL, escaped rendered text and an explicit static-asset allowlist remain in place.
- Uploads are stored by generated IDs outside the public directory, with per-file/workspace limits and bounded concurrent uploads. Active HTML/SVG are delivered as attachments; supported inline previews are sandboxed.
- OCC runs under a dedicated non-login account with restrictive file creation permissions, a read-only system view and a protected home directory.

## Changes in this release

- New/reset passwords require 15–128 characters. Scrypt uses N=32768, r=8, p=3, with a random salt and at most four concurrent hash jobs. Legacy hashes remain verifiable and upgrade on successful login. Existing passwords are not forcibly reset.
- Failed login throttling now covers the account across client addresses as well as the existing IP/account limits. Password-change verification is throttled too. Expired throttle records are pruned; throttle record counts are bounded.
- A bounded per-client request limiter permits 1,200 requests per minute, with HTTP 429 and Retry-After when exceeded. This is abuse resistance for a private deployment, not DDoS protection. Large sync queues may pause and retry.
- At most ten browser sessions per user. HTTP header counts, requests per connection, URL length and idle socket time are bounded.
- Cross-site browser API requests and compressed request bodies are rejected. The immediate trusted proxy's final forwarded address is used only when the peer is loopback and TRUST_PROXY is enabled.
- Added same-origin resource/opener policies, legacy framing protection, disabled DNS prefetch/cross-domain policy files, and explicit CSP connection/worker restrictions. Existing PDF previews remain supported.
- Uploads revalidate the browser session or desktop key and current privileges inside the final database transaction. Current account privileges are re-read when resolving folder access.
- OCC's systemd unit removes capability grants, restricts address families and device access, protects kernel settings/modules/logs, clock and cgroups, restricts realtime/SUID operations, and bounds tasks/file descriptors. No JIT-breaking MemoryDenyWriteExecute setting is used.
- Failed deployment rollback restores the previous service unit as well as the previous release and its matching data backup.
- Backup verification checks SHA-256 where available, not just file size. Manual backups validate source data and gzip integrity, publish the completed archive atomically, and create a checksum file. Backup copies remain local and require off-server protection.

## Validation

- Server tests cover authentication, folder permissions, uploads, persistence, restores, calendar ownership/conflicts and startup through a release symlink.
- Added tests for password-hash migration, secure cookies/headers, cross-site rejection, exposed-path rejection, compressed-body rejection, account throttling across addresses, request limits, revoked in-flight uploads and same-size backup corruption.
- Browser tests cover accounts, uploads/downloads, device connections, calendar booking/edit/delete, annual list and mobile layouts.
- Desktop sync integration covers offline edits, conflict copies, stale revisions, device/folder revocation and Viewer restrictions.
- npm production audit returned no advisories. OCC has no third-party runtime npm dependencies; this does not assess the OS or bundled Node/OpenSSL runtime.

## Remaining operational work before public hosting

- Server package metadata reports Node 22.23.2 installed and 22.23.3 available. The host also reports a required reboot. Coordinate shared runtime updates and restart with the other Oxygen Care services; this OCC release does not patch/reboot the host.
- Unattended upgrades and APT timers are enabled; their repository coverage and successful patch history still need administrator review.
- Confirm Tailscale ACLs and identity-provider MFA. Native OCC MFA, recovery flows and public-facing identity integration are not implemented.
- Configure scheduled encrypted off-server backups, retention, alerting and a periodic restore drill. Deployment backups and the manual backup script are not a disaster-recovery service. No OCC backup timer was found during the read-only check.
- Add malware scanning/quarantine and operational scanning failure handling if untrusted users will upload files. OCC supports arbitrary file types and does not currently scan file contents for malware.
- Audit SSH configuration, firewall rules, full-disk encryption, root-owned data permissions and backup permissions with administrator access. No global SSH/firewall changes were made to avoid disrupting access or other hosted services.
- Restrict access to logs and add monitoring/security alerts. The audit table records events but has no alert delivery/retention policy.
- Inline CSS remains allowed for the current interface, and fonts use Google's explicitly permitted font domains. Script execution remains restricted to same-origin files; self-hosting fonts and removing inline styles are future tightening options.
- Desktop clients remain unsigned internal previews. Native signing/notarization and a secure update channel are separate from website hardening.

## References

- OWASP password storage: https://cheatsheetseries.owasp.org/cheatsheets/Password_Storage_Cheat_Sheet.html
- OWASP session management: https://cheatsheetseries.owasp.org/cheatsheets/Session_Management_Cheat_Sheet.html
- OWASP file uploads: https://cheatsheetseries.owasp.org/cheatsheets/File_Upload_Cheat_Sheet.html
