# OCC · Oxygen Care Cloud

An interactive, responsive file-sharing interface prototype. Open the private hosted Site or run `npm start` and visit http://127.0.0.1:4173.

## Demo

The workspace opens as Alex Morgan (Super User). Use the **Preview account** selector to explore the Manager, Contributor, and Viewer accounts. Use the sign-out button to try the login screen. Every active demo account uses password `OCCdemo2026!`; these are sample accounts, not real authentication.

- Create, rename, move, and delete folders and files.
- Upload arbitrary file types, up to 100 MB per file, through the picker or drag and drop.
- Preview uploaded raster images and PDFs; download uploaded files in their original format.
- Sample records download explanatory text notes, explicitly labelled in the interface.
- Assign per-folder Viewer, Contributor, and Manager access. Children inherit access from the top-level folder.
- Super Users can create, edit, promote, and deactivate accounts. The currently signed-in Super User cannot deactivate or demote themselves.
- Search filenames, filter file types, and switch between list and grid layouts.

## Prototype boundary

All state and uploaded files remain in memory in the current browser tab and reset on refresh. No files are uploaded to a storage service. No invitation emails are sent. Permission checks demonstrate intended behavior in the interface only and are not a security boundary. Use sample information only.

A production version needs server-side identity, authorisation on every file and folder operation, object storage, durable metadata, account provisioning, and operational upload limits. Hosting this prototype privately does not implement those features.

## Verification

`npm run check` checks JavaScript syntax. The end-to-end checks in `tests/workflows.cjs` need Playwright, an installed Chromium browser, and the local server. Supply `PLAYWRIGHT_PATH` and `CHROME_PATH` if they are not on standard paths. `OCC_TEST_URL` can override the local URL. Tests exercise real browser interactions, role restrictions, user provisioning, uploads/downloads, sharing, nested folders, and mobile overflow. Screenshots are written under `test-results/` (ignored from source publishing).

Optional browser tools `list_occ_files` and `create_occ_folder` are feature-detected and share the interface's prototype state and checks.
