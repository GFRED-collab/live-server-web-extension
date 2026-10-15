const assert = require('node:assert/strict');
const { loadTs } = require('./test-load-ts.cjs');
const id = '11111111-1111-4111-8111-111111111111',
  clientId = '22222222-2222-4222-8222-222222222222',
  contractId = '33333333-3333-4333-8333-333333333333',
  deviceId = '44444444-4444-4444-8444-444444444444',
  visitId = '55555555-5555-4555-8555-555555555555',
  requestId = '66666666-6666-4666-8666-666666666666',
  engineerId = '77777777-7777-4777-8777-777777777777';
let role = 'customer',
  canExport = true,
  queries = [],
  audits = [],
  connections = 0,
  releases = 0;
let visitFound = true,
  linked = true,
  owned = true,
  openCount = 0,
  requestStatus = 'new',
  activeEngineer = true;
const auth = loadTs('lib/auth.ts', name => {
  if (name === 'next/headers')
    return {
      cookies: async () => ({ get: () => ({ value: Buffer.alloc(32, 1).toString('base64url') }) })
    };
  if (name.endsWith('/db'))
    return {
      getDb: () => ({
        query: async () => ({
          rows: [{ id, role, can_export: canExport, remaining_ms: 900000 }]
        })
      })
    };
});
const db = {
  release() {
    releases++;
  },
  async query(sql, params) {
    queries.push({ sql, params });
    const one = (rows, ok = true) => ({ rowCount: ok ? rows.length : 0, rows: ok ? rows : [] });
    if (sql.includes('FROM service_visits sv JOIN contracts ct') && sql.includes('JOIN users u'))
      return one([{ clientName: 'Own clinic', summary: 'Checked' }], visitFound);
    if (sql.includes('FROM service_visits sv JOIN contract_devices'))
      return one([{ deviceName: 'Concentrator', comments: 'OK', parts: [] }]);
    if (sql.includes('FROM service_visit_signatures WHERE service_visit_id=$1'))
      return one([{ signerRole: 'engineer', signatureData: 'data:image/png;base64,AA==' }]);
    if (sql.includes('FROM clients c JOIN users u') && sql.includes('FOR UPDATE'))
      return one([{ id: clientId }], linked);
    if (sql.includes('FROM contracts ct')) return one([{ '?column?': 1 }], owned);
    if (sql.includes("status='new'") && sql.startsWith('SELECT count'))
      return one([{ count: openCount }]);
    if (sql.startsWith('INSERT INTO callout_requests'))
      return one([{ id: requestId, reference: 'CR-1' }]);
    if (sql.includes('FROM callout_requests r JOIN clients cl') && sql.includes('FOR UPDATE'))
      return one(
        [
          {
            status: requestStatus,
            description: 'Alarm sounding',
            priority: 'urgent',
            location: '',
            contactName: 'Mary',
            contactPhone: '0871234567',
            reference: 'CR-1',
            clientName: 'Own clinic',
            address: '1 Main St',
            deviceName: 'Concentrator',
            serialNumber: 'SN1'
          }
        ],
        true
      );
    if (sql.startsWith('SELECT 1 FROM users WHERE id=$1 AND active=true AND role'))
      return one([{ '?column?': 1 }], activeEngineer);
    if (sql.startsWith('INSERT INTO callouts')) return one([{ id: 'callout-1' }]);
    return { rowCount: 0, rows: [] };
  }
};
const overrides = name => {
  if (name.endsWith('/auth')) return { requireUser: auth.requireUser };
  if (name.endsWith('/db'))
    return {
      getDb: () => ({
        connect: async () => {
          connections++;
          return db;
        },
        query: db.query
      })
    };
  if (name.endsWith('/audit')) return { writeAudit: async (...args) => audits.push(args) };
};
const report = loadTs('app/api/customer-portal/service-visits/[id]/route.ts', overrides),
  customerRequests = loadTs('app/api/customer-portal/callout-requests/route.ts', overrides),
  staffRequests = loadTs('app/api/callout-requests/route.ts', overrides),
  decide = loadTs('app/api/callout-requests/[id]/route.ts', overrides);
const context = value => ({ params: Promise.resolve({ id: value }) });
const json = (path, method, body) =>
  new Request('https://reports.example' + path, {
    method,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body)
  });
const reset = () => {
  queries = [];
  audits = [];
  connections = 0;
  releases = 0;
};
const committed = () => queries.some(q => q.sql === 'COMMIT');
const rolledBack = () => queries.some(q => q.sql === 'ROLLBACK');
(async () => {
  // Signed service report download.
  role = 'engineer';
  reset();
  assert.equal((await report.GET(null, context(visitId))).status, 403);
  role = 'customer';
  canExport = false;
  reset();
  assert.equal((await report.GET(null, context(visitId))).status, 403);
  assert.equal(connections, 0);
  canExport = true;
  reset();
  assert.equal((await report.GET(null, context('not-a-uuid'))).status, 404);
  assert.equal(connections, 0);
  reset();
  visitFound = false;
  assert.equal((await report.GET(null, context(visitId))).status, 404);
  assert.ok(!queries.some(q => q.sql.includes('FROM service_visit_signatures WHERE')));
  assert.equal(releases, 1);
  visitFound = true;
  reset();
  const ok = await report.GET(null, context(visitId));
  assert.equal(ok.status, 200);
  assert.equal(ok.headers.get('cache-control'), 'no-store');
  const visitSql = queries.find(q => q.sql.includes('JOIN users u'));
  assert.deepEqual(Array.from(visitSql.params), [visitId, id]);
  assert.match(visitSql.sql, /u\.id=\$2 AND u\.role='customer' AND u\.active=true/);
  assert.match(visitSql.sql, /sv\.status='finalized'/);
  assert.match(visitSql.sql, /s\.signer_role='engineer'/);
  assert.match(visitSql.sql, /s\.signer_role='client'/);
  assert.ok(/READ ONLY/.test(queries[0].sql) && committed());
  assert.equal(audits[0][2], 'exported');
  assert.equal(releases, 1);

  // Customer callout requests.
  role = 'super_user';
  reset();
  assert.equal(
    (await customerRequests.POST(json('/api/customer-portal/callout-requests', 'POST', {}))).status,
    403
  );
  role = 'customer';
  reset();
  assert.equal(
    (
      await customerRequests.POST(
        json('/api/customer-portal/callout-requests', 'POST', { description: '  ' })
      )
    ).status,
    400
  );
  assert.equal(connections, 0);
  reset();
  assert.equal(
    (
      await customerRequests.POST(
        json('/api/customer-portal/callout-requests', 'POST', { description: 'Broken 🚨' })
      )
    ).status,
    400
  );
  assert.equal(connections, 0);
  reset();
  assert.equal(
    (
      await customerRequests.POST(
        json('/api/customer-portal/callout-requests', 'POST', {
          description: 'Alarm',
          deviceId
        })
      )
    ).status,
    400
  );
  assert.equal(connections, 0);
  owned = false;
  reset();
  assert.equal(
    (
      await customerRequests.POST(
        json('/api/customer-portal/callout-requests', 'POST', {
          description: 'Alarm',
          contractId,
          deviceId
        })
      )
    ).status,
    400
  );
  assert.ok(rolledBack() && !queries.some(q => q.sql.startsWith('INSERT')));
  assert.deepEqual(Array.from(queries.find(q => q.sql.includes('FROM contracts ct')).params), [
    contractId,
    clientId,
    deviceId
  ]);
  owned = true;
  openCount = 10;
  reset();
  assert.equal(
    (
      await customerRequests.POST(
        json('/api/customer-portal/callout-requests', 'POST', { description: 'Alarm' })
      )
    ).status,
    400
  );
  assert.ok(rolledBack() && !queries.some(q => q.sql.startsWith('INSERT')));
  openCount = 0;
  linked = false;
  reset();
  assert.equal(
    (
      await customerRequests.POST(
        json('/api/customer-portal/callout-requests', 'POST', { description: 'Alarm' })
      )
    ).status,
    403
  );
  linked = true;
  reset();
  const created = await customerRequests.POST(
    json('/api/customer-portal/callout-requests', 'POST', {
      description: 'Alarm sounding',
      priority: 'urgent',
      contractId,
      deviceId,
      clientId: 'someone-else'
    })
  );
  assert.equal(created.status, 201);
  const insert = queries.find(q => q.sql.startsWith('INSERT INTO callout_requests'));
  // The client always comes from the signed-in account, never from the request body.
  assert.equal(insert.params[0], clientId);
  assert.equal(insert.params[4], 'urgent');
  assert.equal(insert.params[8], id);
  assert.ok(committed());
  assert.equal(releases, 1);
  reset();
  assert.equal((await customerRequests.GET()).status, 200);
  assert.match(queries[0].sql, /u\.id=\$1 AND u\.role='customer' AND u\.active=true/);
  // Customers only see the outcome: no staff names, engineer assignment or callout details.
  const returned = queries[0].sql.slice(0, queries[0].sql.indexOf(' FROM '));
  assert.ok(
    !/callout_id|assigned_user|decided_by|requested_by|description AS|c\.description/.test(returned)
  );
  assert.match(returned, /c\.status AS "calloutStatus"/);

  // Super User review.
  for (const staffRole of ['customer', 'engineer']) {
    role = staffRole;
    reset();
    assert.equal((await staffRequests.GET()).status, 403);
    assert.equal(
      (
        await decide.PATCH(
          json('/api/callout-requests/' + requestId, 'PATCH', { action: 'decline', reason: 'x' }),
          context(requestId)
        )
      ).status,
      403
    );
    assert.equal(queries.length, 0);
  }
  role = 'super_user';
  reset();
  assert.equal((await staffRequests.GET()).status, 200);
  reset();
  assert.equal(
    (
      await decide.PATCH(
        json('/api/callout-requests/' + requestId, 'PATCH', { action: 'decline', reason: ' ' }),
        context(requestId)
      )
    ).status,
    400
  );
  assert.equal(connections, 0);
  reset();
  assert.equal(
    (
      await decide.PATCH(
        json('/api/callout-requests/' + requestId, 'PATCH', { action: 'accept' }),
        context(requestId)
      )
    ).status,
    400
  );
  assert.equal(connections, 0);
  activeEngineer = false;
  reset();
  assert.equal(
    (
      await decide.PATCH(
        json('/api/callout-requests/' + requestId, 'PATCH', {
          action: 'accept',
          assignedUserId: engineerId
        }),
        context(requestId)
      )
    ).status,
    400
  );
  assert.ok(rolledBack() && !queries.some(q => q.sql.startsWith('INSERT INTO callouts')));
  activeEngineer = true;
  requestStatus = 'accepted';
  reset();
  assert.equal(
    (
      await decide.PATCH(
        json('/api/callout-requests/' + requestId, 'PATCH', {
          action: 'accept',
          assignedUserId: engineerId
        }),
        context(requestId)
      )
    ).status,
    400
  );
  assert.ok(rolledBack() && !queries.some(q => q.sql.startsWith('INSERT INTO callouts')));
  requestStatus = 'new';
  reset();
  const accepted = await decide.PATCH(
    json('/api/callout-requests/' + requestId, 'PATCH', {
      action: 'accept',
      assignedUserId: engineerId
    }),
    context(requestId)
  );
  assert.equal(accepted.status, 200);
  const callout = queries.find(q => q.sql.startsWith('INSERT INTO callouts'));
  assert.deepEqual(
    [callout.params[0], callout.params[1], callout.params[3], callout.params[4]],
    ['Own clinic', '1 Main St', 'urgent', engineerId]
  );
  assert.match(callout.params[2], /Alarm sounding[\s\S]*Mary · 0871234567[\s\S]*CR-1/);
  const update = queries.find(q => q.sql.startsWith('UPDATE callout_requests'));
  assert.deepEqual(Array.from(update.params), [requestId, 'callout-1', id]);
  assert.ok(committed());
  assert.equal(releases, 1);
  reset();
  assert.equal(
    (
      await decide.PATCH(
        json('/api/callout-requests/' + requestId, 'PATCH', {
          action: 'decline',
          reason: 'Covered by the manufacturer warranty'
        }),
        context(requestId)
      )
    ).status,
    200
  );
  assert.match(queries.find(q => q.sql.startsWith('UPDATE')).sql, /status='declined'/);
  assert.ok(committed() && !queries.some(q => q.sql.startsWith('INSERT INTO callouts')));
  console.log(
    'PASS signed report download (customer-only, export permission, own client, finalized and dual-signed, read-only, audited) and callout requests (account-derived client, owned contract/device, open-request limit, Super User accept/decline, engineer validation, already-handled guard, transactional callout creation; database simulated).'
  );
})().catch(e => {
  console.error(e);
  process.exitCode = 1;
});
