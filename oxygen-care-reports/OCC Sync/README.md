# IHS Sync — internal test preview 0.1.0

Mac (Intel and Apple Silicon) and Windows x64 portable desktop builds. Requires the OCC server schema-2 upgrade and access to its private Tailscale address.

## Install and connect

1. Mac: extract the appropriate ZIP and copy IHS Sync.app to Applications. Windows: extract the entire ZIP into a permanent folder and launch IHS Sync.exe. Keep all extracted files together.
2. These internal builds are unsigned and not notarized. Distribution signing and Windows runtime acceptance testing remain outstanding. Do not distribute as a production release.
3. Sign into OCC in a browser. Select **Desktop sync → Connect a computer**. Name the computer, then copy its one-time connection key.
4. Open IHS Sync, enter the server address and connection key, then choose the shared folders to keep offline.
5. Select a parent directory. The app creates a new **Irish Hospital Supplies Cloud** folder; it refuses to adopt an existing folder. Keys are encrypted using the operating system's secure storage. Passwords are never stored.
6. Keep the application running. It checks for changes every 30 seconds and after sleep. Closing the window quits the application. Reopen it to resume. This preview has no automatic startup or tray service.

## Current behavior and limits

- Files in selected shared folders download for offline use. Locally added files upload when connected; Managers and Super Users can also update existing files. Viewers retain local edits without uploading them. Contributors can upload new files, following the server's existing privileges.
- Concurrent edits preserve the local version with a `.local-…` suffix and download the remote version. These recovery copies are not uploaded automatically. Remote replacements also retain the preceding local file as a recovery copy.
- Local deletions never delete the server copy. Restore a missing local file by downloading it from OCC into its original offline path. Use the browser for shared deletions.
- Create/rename/move folders and rename/move files in the browser. New local subfolders are flagged for review, not uploaded. Remote file moves or renames require review; existing local copies remain at their old paths. Folder paths remain stable after remote renames.
- Offline folder names include an identifier suffix to avoid collisions. Windows-incompatible names are reported for review on both platforms. Symbolic links are not synced.
- Removed remote files and revoked folders retain their local copies and are reported for review. Revoking a device or changing/resetting its user's password blocks future sync. No remote wipe is attempted.
- Connection keys expire after 90 days. Disconnect in the app, revoke its old key in OCC, and reconnect with a new key into a new offline folder. Existing local files are retained; copy any pending edits deliberately.
- Files use the server's size limit (default 100 MB), whole-file transfers and SHA-256 checksums. Transfers retry on a later cycle; they do not resume partially. Available disk space and recovery-copy retention need manual management in this preview.

## Build and test

`npm ci` then `npm run build:mac` or `npm run build:win`. Build outputs are in `dist/`.

`npm test` exercises two clients against a temporary real OCC server: first upload/download, offline changes, conflicts, stale write rejection, local deletion retention, symbolic-link avoidance and device revocation. Server source is expected in the sibling `OCC Oxygen Care Cloud Server` directory. `test/desktop.cjs` is a native Mac packaged-app smoke test using the local Codex Playwright runtime.

The Mac packaged app was smoke-tested on Intel macOS. Apple Silicon and Windows packages are built but have not been launched on their target hardware. Production release requires target-platform acceptance tests, signing/notarization, folder move/delete synchronization, and interrupted-transfer/large-workspace testing.
