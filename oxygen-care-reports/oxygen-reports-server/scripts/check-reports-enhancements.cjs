const assert = require('node:assert/strict');
const { loadTs } = require('./test-load-ts.cjs');
const dates = loadTs('lib/booking-dates.ts'),
  times = loadTs('lib/work-times.ts'),
  csv = loadTs('lib/csv-export.ts'),
  fields = loadTs('lib/report-fields.ts');
const { historyChange } = loadTs('lib/history-change.ts');
const legacy = historyChange({
  entityType: 'report_row',
  kind: 'updated',
  actor: 'admin',
  detail: { fields: ['Service status'], reportId: 'internal-id' }
});
assert.equal(legacy.title, 'Device report updated');
assert.equal(legacy.actor, 'admin');
assert.match(legacy.lines[0], /Service status/);
assert.match(legacy.lines[0], /not recorded/);
assert.ok(!legacy.lines.join('').includes('internal-id'));
const modern = historyChange({
  entityType: 'report_row',
  kind: 'updated',
  detail: {
    changes: [
      { field: 'Service status', from: 'Not serviced', to: 'Serviced' },
      { field: 'Comments', from: '', to: 'Checked' }
    ]
  }
});
assert.equal(modern.lines[0], 'Service status: Not serviced → Serviced');
assert.equal(modern.lines[1], 'Comments: Not set → Checked');
assert.equal(historyChange({ entityType: 'constructor', detail: null }).title, 'Record changed');
assert.equal(dates.validDate('2028-02-29'), true);
assert.equal(dates.validDate('2026-02-29'), false);
for (const day of ['2026-10-31', '2026-11-01', '2026-11-02'])
  assert.equal(
    dates.coversDate({ appointmentDate: '2026-10-31', endDate: '2026-11-02' }, day),
    true
  );
assert.equal(
  dates.coversDate({ appointmentDate: '2026-10-31', endDate: '2026-11-02' }, '2026-11-03'),
  false
);
assert.doesNotThrow(() =>
  times.parseWorkTimes('2026-10-04T23:30:00.000Z', '2026-10-05T01:00:00.000Z')
);
for (const pair of [
  ['', ''],
  ['2026-02-30T10:00:00Z', '2026-03-01T10:00:00Z'],
  ['2026-10-04T12:00:00Z', '2026-10-04T11:00:00Z']
])
  assert.throws(() => times.parseWorkTimes(...pair));
assert.equal(csv.csvCell('=HYPERLINK("bad")').startsWith("'"), true);
assert.equal(csv.csvCell('  +formula').startsWith("'"), true);
assert.equal(csv.csvText(['Name'], [['A,"B"\nC']]), '\uFEFF"Name"\r\n"A,""B""\nC"');
const masked = fields.secureReportRow(
  {
    serialNumber: 'SN1',
    deviceName: 'Private',
    comments: 'Hidden',
    values: { stable: 'Kept', other: 'Hidden' }
  },
  new Set(['Serial Number', 'stable'])
);
assert.equal(masked.serialNumber, 'SN1');
assert.equal(masked.deviceName, '');
assert.equal(masked.comments, '');
assert.equal(masked.values.stable, 'Kept');
assert.equal(masked.values.other, undefined);
assert.equal(fields.standardProperties.constructor, undefined);

const id = '11111111-1111-4111-8111-111111111111';
let user = { id, role: 'super_user', canExport: true },
  queries = [],
  audits = [],
  released = 0,
  mode = 'booking',
  duplicates = [],
  ambiguous = false,
  found = true,
  writable = true;
const seed = {
  id,
  report_id: id,
  client_name: 'Clinic',
  serial_number: 'SN1',
  asset_number: 'A1',
  device_name: 'Machine',
  lot_number: 'L1'
};
const db = {
  release() {
    released++;
  },
  async query(sql, params) {
    queries.push({ sql, params });
    if (mode === 'booking') {
      if (sql.startsWith('INSERT INTO appointments') || sql.startsWith('UPDATE appointments'))
        return { rows: [{ id }], rowCount: 1 };
      if (sql.startsWith('SELECT appointment_date::text'))
        return {
          rows: [{ start: '2026-10-31', end: '2026-11-02', time: null, assigned: id }],
          rowCount: 1
        };
      return { rows: [], rowCount: 0 };
    }
    if (mode === 'field') {
      if (sql.includes('SELECT id,active FROM custom_fields'))
        return { rows: duplicates, rowCount: duplicates.length };
      if (sql.startsWith('UPDATE custom_fields') || sql.startsWith('INSERT INTO custom_fields'))
        return { rows: [{ id, source_key: 'Serial Number' }], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    }
    if (mode === 'row') {
      if (sql.includes('FROM report_rows rr'))
        return {
          rows: [
            {
              reportId: id,
              deviceName: 'Device',
              serialNumber: 'Old',
              lotNumber: '',
              assetNumber: '',
              hoursIn: '',
              hoursOut: '',
              comments: '',
              values: { stable: 'Original' }
            }
          ],
          rowCount: 1
        };
      if (sql.includes('SELECT f.name,f.source_key'))
        return {
          rows: writable ? [{ name: 'Serial ID', sourceKey: 'Serial Number' }] : [],
          rowCount: writable ? 1 : 0
        };
      return { rows: [], rowCount: 1 };
    }
    if (mode === 'history') {
      if (sql.startsWith('SELECT rr.*,r.client_name'))
        return { rows: found ? [seed] : [], rowCount: found ? 1 : 0 };
      if (sql.includes('SELECT f.id,f.name'))
        return {
          rows: [{ id, name: 'Serial ID', sourceKey: 'Serial Number', kind: 'text' }],
          rowCount: 1
        };
      if (sql.includes('FROM devices d JOIN clients'))
        return {
          rows: ambiguous
            ? [
                { id, sourceMatch: false },
                { id: '22222222-2222-4222-8222-222222222222', sourceMatch: false }
              ]
            : [],
          rowCount: ambiguous ? 2 : 0
        };
      if (sql.startsWith('SELECT rr.id,'))
        return {
          rows: [
            {
              id,
              serialNumber: 'SN1',
              deviceName: 'Hidden device',
              comments: 'Hidden comment',
              values: { other: 'Secret' },
              fileName: 'Report.csv',
              date: '2026-10-04'
            }
          ],
          rowCount: 1
        };
      return { rows: [], rowCount: 0 };
    }
    throw Error('Unknown mode');
  }
};
function dependencies(name) {
  if (name.endsWith('/auth'))
    return {
      requireUser: async roles =>
        !user
          ? { response: Response.json({ error: 'Authentication required' }, { status: 401 }) }
          : roles && !roles.includes(user.role)
            ? { response: Response.json({ error: 'Forbidden' }, { status: 403 }) }
            : { user }
    };
  if (name.endsWith('/db')) return { getDb: () => ({ ...db, connect: async () => db }) };
  if (name.endsWith('/audit')) return { writeAudit: async (...args) => audits.push(args) };
  if (name.endsWith('/http'))
    return {
      jsonObject: r => r.json(),
      errorResponse: e => Response.json({ error: e.message }, { status: 400 })
    };
}
const booking = loadTs('app/api/appointments/route.ts', dependencies),
  field = loadTs('app/api/fields/route.ts', dependencies),
  row = loadTs('app/api/report-rows/[id]/route.ts', dependencies),
  history = loadTs('app/api/machine-history/route.ts', dependencies);
const req = (body, method = 'POST') =>
  new Request('http://test/api/test', { method, body: JSON.stringify(body) });
function reset(next) {
  mode = next;
  queries = [];
  audits = [];
}
(async () => {
  reset('booking');
  let response = await booking.POST(
    req({ appointmentDate: '2026-10-31', endDate: '2026-11-02', title: 'Multi-day service' })
  );
  assert.equal(response.status, 201);
  assert.equal(
    queries.find(q => q.sql.startsWith('INSERT INTO appointments')).params[1],
    '2026-11-02'
  );
  for (const body of [
    { appointmentDate: '2026-10-05', endDate: '2026-10-04', title: 'Bad' },
    { appointmentDate: '2026-02-30', title: 'Bad' },
    { appointmentDate: '2026-10-04', startTime: '25:00', title: 'Bad' }
  ]) {
    reset('booking');
    assert.equal((await booking.POST(req(body))).status, 400);
    assert.equal(queries.length, 0);
  }
  reset('booking');
  await booking.GET(new Request('http://test/api/appointments?month=2026-11'));
  assert.match(queries[0].sql, /a.end_date >= \$1::date/);
  reset('booking');
  user = { id, role: 'engineer' };
  await booking.PATCH(
    req(
      {
        id,
        appointmentDate: '2026-10-31',
        endDate: '2026-11-02',
        title: 'Edited',
        assignedUserId: 'other'
      },
      'PATCH'
    )
  );
  const update = queries.find(q => q.sql.startsWith('UPDATE appointments'));
  assert.equal(update.params[8], id);
  const access = queries.find(q => q.sql.startsWith('SELECT appointment_date::text'));
  assert.match(access.sql, /assigned_user_id=\$3 OR created_by=\$3\) FOR UPDATE/);
  assert.deepEqual(Array.from(access.params), [id, 'engineer', id]);
  reset('field');
  assert.equal((await field.DELETE(req({ name: 'Serial Number' }, 'DELETE'))).status, 403);
  assert.equal(queries.length, 0);
  user = { id, role: 'super_user' };
  reset('field');
  assert.equal((await field.DELETE(req({ name: 'Serial Number' }, 'DELETE'))).status, 200);
  assert.ok(queries.some(q => q.sql.includes('active=false')));
  assert.ok(!queries.some(q => q.sql.includes('DELETE FROM report_rows')));
  reset('field');
  assert.equal(
    (await field.PATCH(req({ id, name: 'Serial ID', kind: 'text' }, 'PATCH'))).status,
    200
  );
  assert.ok(
    queries.some(
      q =>
        q.sql.startsWith('UPDATE custom_fields SET name=$2,kind=CASE WHEN source_key=') &&
        q.sql.includes('WHERE id=$1')
    )
  );
  assert.ok(!queries.some(q => q.sql.includes('UPDATE report_rows')));
  reset('field');
  duplicates = [{ id: '22222222-2222-4222-8222-222222222222', active: true }];
  assert.equal(
    (await field.PATCH(req({ id, name: 'Duplicate', kind: 'text' }, 'PATCH'))).status,
    400
  );
  assert.equal(queries.at(-1).sql, 'ROLLBACK');
  reset('field');
  duplicates = [{ id, active: false }];
  assert.equal((await field.POST(req({ name: 'Serial Number', kind: 'text' }))).status, 201);
  assert.ok(queries.some(q => q.sql.includes('active=true WHERE id=$1')));
  duplicates = [];
  reset('row');
  response = await row.PATCH(req({ fields: { 'Serial ID': 'SN-new' } }, 'PATCH'), {
    params: Promise.resolve({ id })
  });
  assert.equal(response.status, 200);
  assert.equal(queries.find(q => q.sql.startsWith('UPDATE report_rows')).params[2], 'SN-new');
  assert.deepEqual(JSON.parse(JSON.stringify(audits[0][5].changes)), [
    { field: 'Serial ID', from: 'Old', to: 'SN-new' }
  ]);
  assert.equal(queries.at(-1).sql, 'COMMIT');
  reset('row');
  writable = false;
  assert.equal(
    (
      await row.PATCH(req({ fields: { 'Serial ID': 'Hidden' } }, 'PATCH'), {
        params: Promise.resolve({ id })
      })
    ).status,
    403
  );
  assert.equal(queries.at(-1).sql, 'ROLLBACK');
  writable = true;
  user = null;
  reset('history');
  assert.equal(
    (await history.GET(new Request('http://test/api/machine-history?row=' + id))).status,
    401
  );
  assert.equal(queries.length, 0);
  user = { id, role: 'engineer' };
  reset('history');
  response = await history.GET(new Request('http://test/api/machine-history?row=' + id));
  assert.equal(response.status, 200);
  const data = await response.json();
  assert.equal(data.reports[0].comments, '');
  assert.equal(data.reports[0].deviceName, '');
  assert.equal(data.reports[0].serialNumber, 'SN1');
  assert.equal(data.reports[0].values.other, undefined);
  assert.ok(!queries.some(q => q.sql.includes('FROM activity_log')));
  assert.equal(queries.at(-1).sql, 'COMMIT');
  const linked = queries.find(q => q.sql.includes('SELECT s.source_report_row_id AS id'));
  assert.ok(!linked.sql.includes('cd.'), 'Source-link query must not reference an unjoined alias');
  const services = queries.find(q => q.sql.includes('SELECT COALESCE(s.id,v.id)'));
  assert.match(services.sql, /LEFT JOIN service_visit_devices/);
  assert.match(services.sql, /cd.added_on<=v.service_date/);
  reset('history');
  found = false;
  assert.equal(
    (await history.GET(new Request('http://test/api/machine-history?row=' + id))).status,
    404
  );
  assert.equal(queries.at(-1).sql, 'ROLLBACK');
  found = true;
  reset('history');
  ambiguous = true;
  assert.equal(
    (await history.GET(new Request('http://test/api/machine-history?row=' + id))).status,
    400
  );
  assert.equal(queries.at(-1).sql, 'ROLLBACK');
  assert.ok(released > 8);
  console.log(
    'PASS: multi-day/month overlap and date validation, standard field removal and safe rename/restore, renamed row updates and permissions, CSV escaping, overnight docket timing, scoped machine history and ambiguous-identity rejection. Database responses were simulated.'
  );
})().catch(e => {
  console.error(e);
  process.exitCode = 1;
});
