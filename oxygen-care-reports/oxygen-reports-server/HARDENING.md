# Security baseline and release checks

This release moves stock import into the Stock page and adds a local application hardening baseline. It is not a penetration-test result or certification.

## Implemented controls

- API writes require an exact same-origin Origin and JSON content type; cross-site Fetch Metadata is rejected. Set APP_URL to the browser-facing site origin before deployment. Command-line API clients must also send that Origin and Content-Type.
- API responses are not cacheable. Responses use nosniff, anti-framing, same-origin referrers, restricted browser permissions and a baseline Content Security Policy. The CSP blocks objects/framing but does not yet restrict script sources: current Next hydration and generated print windows need a separately tested nonce-based policy.
- JSON bodies are limited to 8 MiB even without Content-Length. Stock upload files are limited to 5 MiB in the browser; the resulting API payload is also bounded server-side.
- Login limits are keyed by hashed account identity rather than spoofable forwarded IP headers; attempts are reserved before asynchronous password work and stale entries are pruned. Unknown accounts perform bcrypt verification too. This limiter is process-local: restarts reset it and multiple workers do not share counts. Add persistent/shared rate limiting at the trusted reverse proxy before public exposure.
- Account creation and admin password changes enforce at least 12 characters and at most 72 UTF-8 bytes (bcrypt limit). Password changes revoke existing sessions. Existing passwords are not automatically changed.
- Production dependency lockfile updates source-map-js to 1.2.2. Containers run as a non-root user with dropped capabilities/no-new-privileges. Compose database publishing is limited to localhost.

## Deployment acceptance

1. Set APP_URL to the exact HTTPS origin users access, including a non-default port if applicable. An incorrect value will block sign-in and other writes. Do not trust client-supplied forwarded headers as an origin allow-list.
2. Terminate HTTPS at a trusted reverse proxy (including Tailscale HTTPS where configured); verify Secure session cookies, login/logout and expiry. Enable HSTS at that proxy only after HTTPS is verified. Do not expose the Node port or PostgreSQL publicly.
3. Replace placeholder secrets/credentials, use least-privilege database credentials and verified TLS for remote database connections. Keep secrets out of source control and build contexts.
4. Configure and restore-test encrypted database backups; set patching, audit retention and monitoring policies. Existing audit data and business-history protections are unchanged.
5. Run npm run check, node scripts/check-hardening.cjs and the existing regression scripts. Verify stock import, report upload, printing, dockets and role boundaries against the real database after deployment.

Local browser regression checks use simulated API responses. Docker runtime, live database and server configuration must be verified on the deployment host. No live deployment is performed by these local changes.
