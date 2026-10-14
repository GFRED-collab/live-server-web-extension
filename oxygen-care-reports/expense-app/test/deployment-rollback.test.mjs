import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
const source = readFileSync(new URL('../scripts/remote-update.sh', import.meta.url), 'utf8');
const rollback = source.slice(source.indexOf('rollback() {'), source.indexOf('\ntrap rollback ERR'));
function simulate(ready) {
  // Shadow every external command: never contact services or touch release/data files.
  return spawnSync('/bin/bash', ['-c', `
    set -Eeuo pipefail
    APP_NAME=expense-test
    APP_DIR=/test/release
    BACKUP_FILE=/test/release.tar.gz
    DATA_BACKUP_FILE=/test/data.tar.gz
    PREVIOUS_OVERRIDE=/test/previous.conf
    SYSTEMD_OVERRIDE=/test/security.conf
    HAD_SECURITY_OVERRIDE=1
    BACKUP_READY=${ready}
    sudo() { printf 'sudo %s\\n' "$*"; }
    tar() { printf 'tar %s\\n' "$*"; }
    ${rollback}
    rollback
  `], { encoding: 'utf8' });
}
test('rollback stops the service, restores code only, then restarts', () => {
  const result = simulate(1);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /tar -C \/test\/release -xzf \/test\/release.tar.gz/);
  assert.doesNotMatch(result.stdout, /data.tar.gz/);
  assert.ok(result.stdout.indexOf('systemctl stop') < result.stdout.indexOf('tar -C'));
  assert.ok(result.stdout.indexOf('tar -C') < result.stdout.indexOf('systemctl start'));
});
test('backup failure restarts the old service without attempting restoration', () => {
  const result = simulate(0);
  assert.equal(result.status, 0, result.stderr);
  assert.doesNotMatch(result.stdout, /tar -C/);
  assert.match(result.stdout, /systemctl start expense-test/);
});
