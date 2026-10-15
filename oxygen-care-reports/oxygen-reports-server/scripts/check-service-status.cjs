const assert = require('node:assert/strict');
const { loadTs } = require('./test-load-ts.cjs');
const { serviceStatus } = loadTs('lib/service-status.ts');
let role = 'engineer',
  queries = [],
  released = 0,
  duplicate = false;
const client = {
  query: async (sql, params) => {
    queries.push({ sql, params });
    return {
      rowCount: sql.includes('WHERE lower(name)') ? (duplicate ? 1 : 0) : 1,
      rows: [{ name: 'Serviced' }]
    };
  },
  release() {
    released++;
  }
};
const api = loadTs('app/api/service-status-options/route.ts', name => {
  if (name.endsWith('/auth'))
    return {
      requireUser: async roles =>
        roles && !roles.includes(role)
          ? { response: Response.json({ error: 'Forbidden' }, { status: 403 }) }
          : { user: { id: 'admin', role } }
    };
  if (name.endsWith('/db'))
    return { getDb: () => ({ connect: async () => client, query: client.query }) };
  if (name.endsWith('/audit')) return { writeAudit: async () => {} };
});
const request = name =>
  new Request('https://reports.example/api/service-status-options', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name })
  });
(async () => {
  assert.equal(serviceStatus('Yes'), 'Serviced');
  assert.equal(serviceStatus(false), 'Not serviced');
  assert.equal(serviceStatus('Follow-up required'), 'Follow-up required');
  assert.equal((await api.POST(request('Awaiting parts'))).status, 403);
  assert.equal(queries.length, 0);
  role = 'super_user';
  assert.equal((await api.POST(request(' Awaiting parts '))).status, 201);
  assert.ok(queries.some(q => q.sql.startsWith('INSERT') && q.params[0] === 'Awaiting parts'));
  assert.equal(released, 1);
  duplicate = true;
  queries = [];
  assert.equal((await api.POST(request('Serviced'))).status, 400);
  assert.ok(queries.some(q => q.sql === 'ROLLBACK'));
  assert.equal(released, 2);
  assert.equal((await api.POST(request('x'.repeat(81)))).status, 400);
  console.log(
    'PASS status normalization, admin-only additions, option validation and duplicate rollback. Database simulated.'
  );
})().catch(e => {
  console.error(e);
  process.exitCode = 1;
});
