const assert = require('node:assert/strict');
const fs = require('node:fs');
const { loadTs } = require('./test-load-ts.cjs');
let queries = [],
  connections = 0,
  releases = 0,
  allowed = false,
  auditFails = false;
let stockParams;
const user = { id: '11111111-1111-4111-8111-111111111111', role: 'super_user' };
const client = {
  async query(sql, params) {
    queries.push(sql);
    if (sql.startsWith('INSERT INTO spare_parts')) stockParams = params;
    if (sql.startsWith('SELECT sv.status'))
      return { rowCount: allowed ? 1 : 0, rows: allowed ? [{ status: 'draft' }] : [] };
    if (sql.startsWith('SELECT status')) return { rowCount: 1, rows: [{ status: 'finalized' }] };
    if (sql.startsWith('DELETE FROM fitted_parts')) return { rowCount: 1, rows: [{ id: 'part' }] };
    return { rowCount: 1, rows: [{ id: 'record', part_number: 'P1', name: 'Part' }] };
  },
  release() {
    releases++;
  }
};
const mock = name => {
  if (name.endsWith('/auth')) return { requireUser: async () => ({ user }) };
  if (name.endsWith('/db'))
    return {
      getDb: () => ({
        connect: async () => {
          connections++;
          return client;
        },
        query: client.query
      })
    };
  if (name.endsWith('/audit'))
    return {
      writeAudit: async () => {
        queries.push('AUDIT');
        if (auditFails) throw Error('Audit failed');
      }
    };
};
const request = body =>
  new Request('https://reports.example/api/test', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body)
  });
const context = { params: Promise.resolve({ id: 'visit', deviceId: 'device' }) };
const reset = () => {
  queries = [];
  connections = 0;
  releases = 0;
};
(async () => {
  const parts = loadTs('app/api/service-visits/[id]/parts/route.ts', mock);
  reset();
  assert.equal((await parts.POST(request({}), context)).status, 400);
  assert.equal(connections, 0);
  reset();
  assert.equal(
    (await parts.POST(request({ deviceId: 'device', partId: 'part', quantity: 1 }), context))
      .status,
    404
  );
  assert.ok(queries.includes('ROLLBACK'));
  assert.equal(releases, 1);
  assert.ok(
    queries.some(sql => sql.includes('cd.device_id=$4') && sql.includes('FOR UPDATE OF sv'))
  );
  assert.ok(!queries.some(sql => sql.startsWith('INSERT')));
  const devices = loadTs('app/api/service-visits/[id]/devices/[deviceId]/route.ts', mock);
  reset();
  assert.equal((await devices.PUT(request({}), context)).status, 404);
  assert.ok(queries.includes('ROLLBACK'));
  assert.equal(releases, 1);
  reset();
  auditFails = true;
  assert.equal((await parts.DELETE(request({ fittedPartId: 'part' }), context)).status, 400);
  assert.ok(queries.includes('ROLLBACK'));
  assert.ok(!queries.includes('COMMIT'));
  assert.equal(releases, 1);
  auditFails = false;
  const visits = loadTs('app/api/service-visits/[id]/route.ts', mock);
  reset();
  assert.equal((await visits.PATCH(request({ title: 'changed' }), context)).status, 400);
  assert.ok(queries.includes('ROLLBACK'));
  assert.ok(!queries.some(sql => sql.startsWith('UPDATE')));
  const stock = loadTs('app/api/stock/parts/route.ts', mock);
  for (const parts of [
    [],
    [null],
    [{}],
    [{ partNumber: 'P1', name: 'Part', warehouseQuantity: -1 }],
    [
      { partNumber: 'P1', name: 'Part', warehouseQuantity: 0 },
      { partNumber: 'P1', name: 'Part', warehouseQuantity: 1 }
    ]
  ]) {
    reset();
    assert.equal((await stock.PUT(request({ parts }))).status, 400);
    assert.equal(connections, 0);
  }
  reset();
  assert.equal(
    (
      await stock.PUT(
        request({ parts: [{ partNumber: 'P1', name: 'Part', warehouseQuantity: 2 }] })
      )
    ).status,
    200
  );
  assert.ok(queries.includes('COMMIT'));
  assert.equal(releases, 1);
  assert.equal(stockParams[3], null);
  assert.ok(queries.some(sql => sql.includes('location=COALESCE($4,spare_parts.location)')));
  reset();
  assert.equal(
    (
      await stock.PUT(
        request({
          parts: [{ partNumber: 'P1', name: 'Part', warehouseQuantity: 2, location: ' Shelf B2 ' }]
        })
      )
    ).status,
    200
  );
  assert.equal(stockParams[3], 'Shelf B2');
  reset();
  assert.equal(
    (
      await stock.PUT(
        request({
          parts: [
            { partNumber: 'P1', name: 'Part', warehouseQuantity: 2, location: 'x'.repeat(161) }
          ]
        })
      )
    ).status,
    400
  );
  assert.equal(connections, 0);
  const page = fs.readFileSync('app/page.tsx', 'utf8');
  assert.ok(!page.includes('oxygen-stock-import'));
  assert.ok(!page.includes('sidebar-stock-import'));
  const ignore = fs.readFileSync('.dockerignore', 'utf8');
  assert.ok(ignore.includes('.env.*'));
  assert.ok(ignore.includes('*.key'));
  console.log(
    'PASS service-device scope, denied/error transaction cleanup, atomic part audit, finalized-visit guard, pre-SQL stock validation and obsolete import removal. Database responses simulated.'
  );
})().catch(e => {
  console.error(e);
  process.exitCode = 1;
});
