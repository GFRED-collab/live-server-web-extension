import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
const source = readFileSync(new URL('../server.mjs', import.meta.url), 'utf8');
test('state-changing routes are serialised and a failed request releases the queue', async () => {
  const calls = [];
  let active = 0,
    maximum = 0;
  const context = {
    URL,
    console: { error() {} },
    routeRequest: async req => {
      active++;
      maximum = Math.max(maximum, active);
      await new Promise(resolve => setTimeout(resolve, 5));
      calls.push(req.method);
      active--;
      if (req.method === 'PATCH') throw Error('Expected test failure');
    }
  };
  const routeSource = source.slice(
    source.indexOf('function requiresDataWriteLock('),
    source.indexOf('const server = createServer(')
  );
  const route = vm.runInNewContext(
    'let dataWriteQueue = Promise.resolve();\n' + routeSource + '\nroute;',
    context
  );
  const results = await Promise.allSettled(
    ['POST', 'PATCH', 'DELETE', 'PUT'].map(method =>
      route({ method, url: '/api/expenses/test' }, {})
    )
  );
  assert.equal(maximum, 1);
  assert.deepEqual(calls, ['POST', 'PATCH', 'DELETE', 'PUT']);
  assert.equal(results[1].status, 'rejected');
  assert.equal(results[3].status, 'fulfilled');
});
test('cloud OCR cannot send receipts without explicit opt-in, even with credentials', async () => {
  const start = source.indexOf('async function scanWithAzure(');
  const end = source.indexOf('\n}', start) + 2;
  let requests = 0;
  const context = {
    process: {
      env: {
        AZURE_DOCUMENT_INTELLIGENCE_ENDPOINT: 'https://example.test',
        AZURE_DOCUMENT_INTELLIGENCE_KEY: 'test-only'
      }
    },
    URL,
    fetchWithTimeout: async () => {
      requests++;
      return { ok: false, status: 403 };
    },
    console: { error() {} }
  };
  const scan = vm.runInNewContext('(' + source.slice(start, end) + ')', context);
  await assert.rejects(scan('test', 'image/jpeg'), /Cloud receipt processing is disabled/);
  assert.equal(requests, 0);
  context.process.env.OCR_ALLOW_CLOUD = 'true';
  context.process.env.AZURE_DOCUMENT_INTELLIGENCE_ENDPOINT = 'http://example.test';
  await assert.rejects(scan('test', 'image/jpeg'), /secure HTTPS/);
  assert.equal(requests, 0);
  context.process.env.AZURE_DOCUMENT_INTELLIGENCE_ENDPOINT = 'https://example.test';
  await assert.rejects(scan('test', 'image/jpeg'), /Receipt service is unavailable/);
  assert.equal(requests, 1);
});
test('unsupported SVG decoding and upstream redirects are blocked', () => {
  assert.match(source, /sharp.block\(\{ operation: \['VipsForeignLoadSvg'\]/);
  assert.match(source, /redirect: 'error'/);
});
