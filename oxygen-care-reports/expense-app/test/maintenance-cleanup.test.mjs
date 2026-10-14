import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const run = promisify(execFile);
const appDir = dirname(dirname(fileURLToPath(import.meta.url)));

test('maintenance cleanup removes redundant history and quarantines only orphan receipts', async () => {
  const root = await mkdtemp(join(tmpdir(), 'oxygen-maintenance-'));
  const deployed = join(root, 'app');
  const data = join(deployed, 'data');
  const receipts = join(data, 'receipts');
  const quarantine = join(root, 'quarantine');
  const referenced = `${'a'.repeat(32)}.jpg`;
  const orphaned = `${'b'.repeat(32)}.pdf`;
  const unrelated = 'keep-me.txt';

  try {
    await mkdir(receipts, { recursive: true });
    await writeFile(join(data, 'expenses.json'), JSON.stringify([{ id: 'one', receiptFile: referenced, reviewHistory: [{ status: 'approved' }] }]));
    await Promise.all([
      writeFile(join(receipts, referenced), 'referenced'),
      writeFile(join(receipts, orphaned), 'orphaned'),
      writeFile(join(receipts, unrelated), 'unrelated')
    ]);

    const { stdout } = await run(process.execPath, [join(appDir, 'scripts', 'maintenance-cleanup.mjs'), deployed, quarantine]);
    assert.deepEqual(JSON.parse(stdout), { historiesRemoved: 1, receiptsQuarantined: 1 });
    assert.deepEqual(JSON.parse(await readFile(join(data, 'expenses.json'), 'utf8')), [{ id: 'one', receiptFile: referenced }]);
    assert.deepEqual((await readdir(receipts)).sort(), [referenced, unrelated].sort());
    assert.deepEqual(await readdir(quarantine), [orphaned]);

    const second = await run(process.execPath, [join(appDir, 'scripts', 'maintenance-cleanup.mjs'), deployed, quarantine]);
    assert.deepEqual(JSON.parse(second.stdout), { historiesRemoved: 0, receiptsQuarantined: 0 });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
