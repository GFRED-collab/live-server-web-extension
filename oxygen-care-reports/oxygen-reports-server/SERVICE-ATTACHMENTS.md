# Device service attachments

Apply migration 016 using `npm run db:migrate` before running this release.

Each device in a service visit has photo/PDF upload, download and removal controls. Machine history provides read-only downloads for the corresponding visit. Finalized visits reject upload/removal on the server. Access requires a Super User or assignment to that visit's contract.

Supported files: JPEG, PNG, WebP and PDF; maximum 5 MiB per file. HEIC is not supported. Extension and file signatures are checked; this is not malware scanning. Downloads are forced attachments with no-sniff and sandbox headers.

Files are stored privately in PostgreSQL, not public web directories. Include the database in backups and capacity planning. Removal hides an attachment but retains the original and audit record. Limits per device/visit are 20 files and 50 MiB including retained originals. Permanent retention/purge policy and malware scanning require separate operational configuration.

Run `node scripts/check-service-attachments.cjs` for simulated API/validation regression checks. A deployed PostgreSQL migration and browser upload/download smoke test are still required before release.
