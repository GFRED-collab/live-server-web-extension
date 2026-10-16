const assert = require('node:assert/strict');
const { loadTs } = require('./test-load-ts.cjs');
const userId = '11111111-1111-4111-8111-111111111111',
  engineerId = '22222222-2222-4222-8222-222222222222',
  otherId = '33333333-3333-4333-8333-333333333333',
  appointmentId = '44444444-4444-4444-8444-444444444444';
let role = 'super_user',
  queries = [],
  audits = [],
  assigneeRole = 'engineer',
  assigneeActive = true,
  previous = null,
  current = 'pending';
const auth = loadTs('lib/auth.ts', name => {
  if (name === 'next/headers')
    return {
      cookies: async () => ({ get: () => ({ value: Buffer.alloc(32, 1).toString('base64url') }) })
    };
  if (name.endsWith('/db'))
    return {
      getDb: () => ({
        query: async () => ({
          rows: [{ id: role === 'engineer' ? engineerId : userId, role, remaining_ms: 900000 }]
        })
      })
    };
});
const one = (rows, ok = true) => ({ rowCount: ok ? rows.length : 0, rows: ok ? rows : [] });
const db = {
  release() {},
  async query(sql, params) {
    queries.push({ sql, params });
    if (sql.startsWith('SELECT appointment_date::text')) return one([previous], !!previous);
    if (sql.startsWith('SELECT role FROM users'))
      return one([{ role: assigneeRole }], assigneeActive);
    if (sql.startsWith('SELECT response_status')) return one([{ status: current }], !!current);
    if (
      sql.startsWith('INSERT INTO appointments') ||
      sql.startsWith('UPDATE appointments SET appointment_date')
    )
      return one([{ id: appointmentId }]);
    if (sql.includes('count(*)::int')) return one([{ count: 2 }]);
    return { rowCount: 1, rows: [] };
  }
};
const overrides = name => {
  if (name.endsWith('/auth')) return { requireUser: auth.requireUser };
  if (name.endsWith('/db')) return { getDb: () => ({ connect: async () => db, query: db.query }) };
  if (name.endsWith('/audit')) return { writeAudit: async (...args) => audits.push(args) };
};
const appointments = loadTs('app/api/appointments/route.ts', overrides),
  respond = loadTs('app/api/appointments/respond/route.ts', overrides);
const json = (path, method, body) =>
  new Request('https://reports.example' + path, {
    method,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body)
  });
const reset = () => {
  queries = [];
  audits = [];
};
const saved = () =>
  queries.find(
    q =>
      q.sql.startsWith('INSERT INTO appointments') ||
      q.sql.startsWith('UPDATE appointments SET appointment_date')
  );
const entry = (extra = {}) => ({
  appointmentDate: '2026-11-02',
  title: 'Service visit',
  startTime: '09:30',
  assignedUserId: engineerId,
  ...extra
});
(async () => {
  // A Super User assigning an engineer asks the engineer to accept it.
  reset();
  let response = await appointments.POST(json('/api/appointments', 'POST', entry()));
  assert.equal(response.status, 201);
  assert.equal((await response.json()).responseStatus, 'pending');
  assert.equal(saved().params.at(-1), 'pending');
  assert.ok(queries.some(q => q.sql === 'COMMIT'));
  // Assigning a non-engineer, nobody, or yourself asks no one.
  for (const [extra, roleOf] of [
    [{}, 'warehouse_user'],
    [{ assignedUserId: '' }, 'engineer'],
    [{ assignedUserId: userId }, 'engineer']
  ]) {
    reset();
    assigneeRole = roleOf;
    response = await appointments.POST(json('/api/appointments', 'POST', entry(extra)));
    assert.equal(response.status, 201);
    assert.equal(saved().params.at(-1), 'none');
  }
  assigneeRole = 'engineer';
  // An inactive assignee is refused.
  reset();
  assigneeActive = false;
  response = await appointments.POST(json('/api/appointments', 'POST', entry()));
  assert.equal(response.status, 400);
  assert.ok(queries.some(q => q.sql === 'ROLLBACK'));
  assigneeActive = true;
  // Editing only the title keeps the engineer's answer; moving it asks again.
  previous = { start: '2026-11-02', end: '2026-11-02', time: '09:30', assigned: engineerId };
  reset();
  response = await appointments.PATCH(
    json('/api/appointments', 'PATCH', entry({ id: appointmentId, title: 'Renamed' }))
  );
  assert.equal(response.status, 200);
  assert.equal(saved().params.at(-1), null);
  assert.match(saved().sql, /COALESCE\(\$10::text,response_status\)/);
  reset();
  response = await appointments.PATCH(
    json('/api/appointments', 'PATCH', entry({ id: appointmentId, startTime: '11:00' }))
  );
  assert.equal(saved().params.at(-1), 'pending');
  reset();
  response = await appointments.PATCH(
    json('/api/appointments', 'PATCH', entry({ id: appointmentId, assignedUserId: otherId }))
  );
  assert.equal(saved().params.at(-1), 'pending');
  // An engineer editing keeps the existing answer.
  role = 'engineer';
  reset();
  response = await appointments.PATCH(
    json('/api/appointments', 'PATCH', entry({ id: appointmentId, startTime: '12:00' }))
  );
  assert.equal(response.status, 200);
  assert.equal(saved().params.at(-1), null);
  assert.ok(!queries.some(q => q.sql.startsWith('SELECT role FROM users')));
  // The badge counts the engineer's own waiting appointments.
  reset();
  response = await appointments.GET(
    new Request('https://reports.example/api/appointments?notifications=1')
  );
  assert.deepEqual(await response.json(), { count: 2 });
  assert.deepEqual(Array.from(queries[0].params), ['engineer', engineerId]);
  reset();
  await appointments.GET(new Request('https://reports.example/api/appointments?pending=1'));
  assert.match(queries[0].sql, /response_status='pending' AND a\.assigned_user_id=\$1/);
  assert.deepEqual(Array.from(queries[0].params), [engineerId]);

  // Answering: only the assigned user, only while pending, a reason to reject.
  const answer = body => respond.POST(json('/api/appointments/respond', 'POST', body));
  reset();
  assert.equal((await answer({ id: appointmentId, decision: 'rejected', note: '  ' })).status, 400);
  assert.equal(queries.length, 0);
  assert.equal((await answer({ id: appointmentId, decision: 'maybe' })).status, 400);
  assert.equal((await answer({ id: 'x', decision: 'accepted' })).status, 400);
  assert.equal(
    (await answer({ id: appointmentId, decision: 'rejected', note: 'x'.repeat(1001) })).status,
    400
  );
  reset();
  response = await answer({
    id: appointmentId,
    decision: 'rejected',
    note: ' On leave that week '
  });
  assert.equal(response.status, 200);
  const lookup = queries.find(q => q.sql.startsWith('SELECT response_status'));
  assert.match(lookup.sql, /assigned_user_id=\$2 FOR UPDATE/);
  assert.deepEqual(Array.from(lookup.params), [appointmentId, engineerId]);
  const update = queries.find(q => q.sql.startsWith('UPDATE appointments SET response_status'));
  assert.deepEqual(Array.from(update.params), [appointmentId, 'rejected', 'On leave that week']);
  assert.equal(audits[0][4], appointmentId);
  assert.equal(audits[0][5].responseStatus, 'rejected');
  reset();
  current = 'accepted';
  response = await answer({ id: appointmentId, decision: 'accepted' });
  assert.equal(response.status, 400);
  assert.ok(queries.some(q => q.sql === 'ROLLBACK'));
  assert.ok(!queries.some(q => q.sql.startsWith('UPDATE')));
  current = null;
  reset();
  assert.equal((await answer({ id: appointmentId, decision: 'accepted' })).status, 400);
  current = 'pending';
  reset();
  assert.equal((await answer({ id: appointmentId, decision: 'accepted' })).status, 200);
  console.log('Appointment response checks passed.');
})().catch(error => {
  console.error(error);
  process.exit(1);
});
