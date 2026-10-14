# Visit-scoped imports

Apply migration 019 before release. It links report uploads to service visits and backfills existing legacy source-report links. Historical duplicates are not deleted or merged.

Report tools requires a contract and explicitly selected draft service visit. The client comes from that contract. Create a service visit first if necessary. Preview lists accepted and skipped counts and each flagged row. Cancel creates no fields or report records. Confirmation rechecks against the current database, so final counts can change after concurrent edits.

Serial numbers are compared after trimming and lowercasing. Asset numbers are the fallback when serial is absent. Different serials remain different devices even when an asset number is shared. Duplicate scope is the uploaded file and selected service visit; later visits and different clients are allowed. Existing device-service records and linked report rows are both checked. Missing identifiers, ambiguous asset matches and decommissioned/out-of-contract devices are flagged and skipped instead of matched automatically.

Accepted rows create report and service-device history records; new devices are registered to the selected contract from the service date. Existing data is not overwritten. All-duplicate files create no empty reports. Maximum 10,000 data rows and existing upload/JSON size limits apply. Warning row numbers refer to parsed non-empty rows with one header, not physical CSV lines.

Visit/client locks serialize imports; the unique visit/device constraint is a final safeguard. Import transaction failures roll back report/device/service/audit writes. New custom fields use the existing separate admin API and can remain if a later import commit fails. Finalized visits cannot receive imports.

Automated API tests simulate PostgreSQL. Verify migration 019, two visits with the same machine, and concurrent imports against staging PostgreSQL before deployment. No production migration or deployment has been performed.
