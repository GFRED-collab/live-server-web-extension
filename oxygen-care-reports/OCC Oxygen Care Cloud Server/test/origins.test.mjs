import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createApp } from '../server.mjs';

test('the public domain is accepted alongside APP_ORIGIN; other origins are refused', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'occ-origins-'));
  const app = createApp({
    dataDir: dir,
    origin: 'https://occ.tailnet.test:8444',
    extraOrigins: ['https://cloud.example.test'],
    production: true,
    setupToken: 'test'
  });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const base = 'http://127.0.0.1:' + app.server.address().port;
  const login = origin =>
    fetch(base + '/api/login', {
      method: 'POST',
      headers: { Origin: origin, 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'nobody@example.test', password: 'wrong-password-123' })
    }).then(response => response.status);
  try {
    // Wrong credentials, but the origin check passes, so the answer is not 403.
    assert.notEqual(await login('https://occ.tailnet.test:8444'), 403);
    assert.notEqual(await login('https://cloud.example.test'), 403);
    assert.equal(await login('https://evil.example.test'), 403);
    assert.equal(await login('http://cloud.example.test'), 403);
    // Production refuses a non-HTTPS or path-bearing extra origin at start-up.
    for (const extraOrigins of [['http://cloud.example.test'], ['https://cloud.example.test/app']])
      assert.throws(() =>
        createApp({
          dataDir: dir,
          origin: 'https://occ.tailnet.test:8444',
          extraOrigins,
          production: true,
          setupToken: 'test'
        })
      );
  } finally {
    app.server.closeAllConnections();
    await new Promise(resolve => app.server.close(resolve));
    await rm(dir, { recursive: true, force: true });
  }
});
