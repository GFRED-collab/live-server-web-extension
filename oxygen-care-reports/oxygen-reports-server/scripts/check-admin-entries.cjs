const fs = require('node:fs'),
  vm = require('node:vm'),
  ts = require('typescript'),
  assert = require('node:assert/strict');
const id = '11111111-1111-4111-8111-111111111111';
let user = { id, role: 'super_user' },
  record = {
    id,
    client_name: 'Clinic',
    description: 'Original',
    location: 'Dublin',
    priority: 'normal',
    status: 'open'
  },
  version = 'v1',
  queries = [],
  audit = [],
  released = 0,
  linked = false,
  shortStock = false;
function compile(path, dependencies) {
  const exports = {};
  vm.runInNewContext(
    ts.transpileModule(fs.readFileSync(path, 'utf8'), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
    }).outputText,
    { exports, Response, Request, URL, Date, console, require: dependencies }
  );
  return exports;
}
const defs = compile('lib/entry-definitions.ts', () => {
  throw Error('unexpected import');
}).entryDefinitions;
const client = {
  async query(sql, params) {
    queries.push({ sql, params });
    if (sql.includes('to_jsonb(t) AS record') || sql.includes('to_jsonb(d) AS record'))
      return { rows: [{ record: { ...record }, version }], rowCount: 1 };
    if (sql.includes('to_jsonb(sv) AS visit'))
      return {
        rows: [
          {
            visit: record,
            signatures: [{ signer_name: 'Customer', signature_data: 'data:image/png;base64,AAAA' }],
            client: { name: 'Clinic' },
            devices: []
          }
        ],
        rowCount: 1
      };
    if (sql.includes('FROM pg_constraint'))
      return {
        rows: linked ? [{ schema: 'public', table: 'dockets', column: 'callout_id' }] : [],
        rowCount: linked ? 1 : 0
      };
    if (sql.startsWith('SELECT 1 FROM "public"')) return { rows: [{}], rowCount: 1 };
    if (sql.includes('SELECT sv.id')) return { rows: [], rowCount: 0 };
    if (sql.startsWith('UPDATE engineer_stock') || sql.startsWith('UPDATE spare_parts'))
      return { rows: [], rowCount: shortStock ? 0 : 1 };
    return { rows: [], rowCount: 1 };
  },
  release() {
    released++;
  }
};
function dependencies(name) {
  if (name.endsWith('/client-name'))
    return require('./test-load-ts.cjs').loadTs('lib/client-name.ts');
  if (name.endsWith('/work-times'))
    return require('./test-load-ts.cjs').loadTs('lib/work-times.ts');
  if (name.endsWith('/auth'))
    return {
      requireUser: async roles =>
        !user
          ? { response: Response.json({ error: 'Authentication required' }, { status: 401 }) }
          : roles && !roles.includes(user.role)
            ? { response: Response.json({ error: 'Forbidden' }, { status: 403 }) }
            : { user }
    };
  if (name.endsWith('/db')) return { getDb: () => ({ ...client, connect: async () => client }) };
  if (name.endsWith('/audit')) return { writeAudit: async (...args) => audit.push(args) };
  if (name.endsWith('/http'))
    return {
      jsonObject: require('./test-load-ts.cjs').loadTs('lib/http.ts').jsonObject,
      errorResponse: e => Response.json({ error: e.message }, { status: 400 })
    };
  if (name.endsWith('/entry-definitions')) return { entryDefinitions: defs };
  throw Error(name);
}
const route = compile('app/api/admin/entries/route.ts', dependencies);
const docketRoute = compile('app/api/fieldwork/dockets/[id]/route.ts', dependencies);
function request(body, method = 'PATCH') {
  return new Request('http://test/api/admin/entries', { method, body: JSON.stringify(body) });
}
function input(kind, fields = {}) {
  return { kind, id, version: 'v1', reason: 'Correct test entry', fields };
}
function fields(kind) {
  return Object.fromEntries(
    defs[kind].fields.map(f => [
      f.name,
      f.options?.[0] ||
        (f.type === 'date' ? '2026-10-03' : f.type === 'number' ? '2' : f.required ? 'Example' : '')
    ])
  );
}
function reset() {
  queries = [];
  audit = [];
  linked = false;
  shortStock = false;
  version = 'v1';
}
(async () => {
  user = null;
  assert.equal((await route.GET(new Request('http://test/api/admin/entries'))).status, 401);
  user = { id, role: 'engineer' };
  assert.equal((await route.PATCH(request(input('callouts', fields('callouts'))))).status, 403);
  assert.equal(queries.length, 0);
  user = { id, role: 'super_user' };
  assert.equal(
    (await route.GET(new Request('http://test/api/admin/entries?kind=users'))).status,
    400
  );
  reset();
  record = { id, client_name: 'Clinic 🏥', description: 'Old 😀 entry', status: 'open' };
  const removed = await route.DELETE(
    request(input('callouts', { description: 'Old 😀 entry' }), 'DELETE')
  );
  assert.equal(removed.status, 200);
  assert.equal(queries.at(-1).sql, 'COMMIT');
  assert.ok(queries.some(q => q.sql.startsWith('DELETE FROM "callouts"')));
  const preserved = queries.find(q => q.sql.includes('INSERT INTO admin_entry_history'));
  assert.equal(JSON.parse(preserved.params[4]).description, 'Old 😀 entry');
  assert.equal(audit.length, 1);
  reset();
  const badReason = await route.DELETE(
    request({ ...input('callouts'), reason: 'Remove 😀' }, 'DELETE')
  );
  assert.equal(badReason.status, 400);
  assert.equal(queries.length, 0);
  record = {
    id,
    client_name: 'Clinic',
    description: 'Original',
    location: 'Dublin',
    priority: 'normal',
    status: 'open'
  };
  for (const [kind, key] of [
    ['clients', 'name'],
    ['reports', 'client_name']
  ]) {
    reset();
    const denied = await route.PATCH(request(input(kind, { [key]: 'Clinic 🏥' })));
    assert.equal(denied.status, 400);
    assert.match((await denied.json()).error, /Emojis are not allowed/);
    assert.equal(queries.length, 0);
  }
  reset();
  let response = await route.PATCH(
    request(input('callouts', { ...fields('callouts'), assigned_by: id }))
  );
  assert.equal(response.status, 400);
  assert.equal(queries.length, 0);
  reset();
  version = 'v2';
  response = await route.DELETE(request(input('callouts'), 'DELETE'));
  assert.equal(response.status, 400);
  assert.equal(queries.at(-1).sql, 'ROLLBACK');
  assert.equal(audit.length, 0);
  reset();
  response = await route.PATCH(request(input('callouts', fields('callouts'))));
  assert.equal(response.status, 200);
  const archive = queries.findIndex(q => q.sql.includes('INSERT INTO admin_entry_history')),
    update = queries.findIndex(q => q.sql.startsWith('UPDATE "callouts"'));
  assert.ok(archive < update);
  assert.equal(JSON.parse(queries[archive].params[4]).description, 'Original');
  assert.equal(queries.at(-1).sql, 'COMMIT');
  assert.equal(audit.length, 1);
  reset();
  linked = true;
  response = await route.DELETE(request(input('callouts'), 'DELETE'));
  assert.equal(response.status, 400);
  assert.equal(queries.at(-1).sql, 'ROLLBACK');
  assert.ok(!queries.some(q => q.sql.startsWith('DELETE')));
  reset();
  response = await route.PATCH(
    request(input('appointments', { ...fields('appointments'), appointment_date: '2026-02-30' }))
  );
  assert.equal(response.status, 400);
  assert.equal(queries.at(-1).sql, 'ROLLBACK');
  reset();
  record = { id, quantity: 5, movement: 'assigned', part_id: id, engineer_id: id, detail: 'Old' };
  response = await route.PATCH(
    request(input('stock_movements', { quantity: '3', detail: 'Corrected' }))
  );
  assert.equal(response.status, 200);
  assert.equal(queries.find(q => q.sql.startsWith('UPDATE engineer_stock')).params[2], 2);
  assert.equal(
    queries.find(q => q.sql.includes('warehouse_quantity=warehouse_quantity+')).params[1],
    2
  );
  reset();
  shortStock = true;
  response = await route.DELETE(request(input('stock_movements'), 'DELETE'));
  assert.equal(response.status, 400);
  assert.equal(queries.at(-1).sql, 'ROLLBACK');
  assert.equal(audit.length, 0);
  reset();
  record = { id, quantity: 5, movement: 'fitted', part_id: id, engineer_id: id };
  response = await route.DELETE(request(input('stock_movements'), 'DELETE'));
  assert.equal(response.status, 200);
  assert.equal(queries.find(q => q.sql.includes('INSERT INTO engineer_stock')).params[2], 5);
  reset();
  record = { id, signature_data: 'data:image/png;base64,AAAA', signer_name: 'Customer' };
  response = await route.PATCH(request(input('dockets', fields('dockets'))));
  assert.equal(response.status, 200);
  assert.match(
    queries.find(q => q.sql.startsWith('UPDATE "dockets"')).sql,
    /correction_pending=true,signature_data=''/
  );
  assert.equal(
    JSON.parse(queries.find(q => q.sql.includes('INSERT INTO admin_entry_history')).params[4])
      .signature_data,
    record.signature_data
  );
  reset();
  record = { id, status: 'finalized' };
  response = await route.PATCH(request(input('service_visits', fields('service_visits'))));
  assert.equal(response.status, 200);
  assert.equal(
    JSON.parse(queries.find(q => q.sql.includes('INSERT INTO admin_entry_history')).params[4])
      .signatures[0].signer_name,
    'Customer'
  );
  assert.ok(queries.some(q => q.sql.startsWith('DELETE FROM service_visit_signatures')));
  assert.match(
    queries.find(q => q.sql.startsWith('UPDATE "service_visits"')).sql,
    /status='draft'/
  );
  reset();
  record = { id, correction_pending: true };
  version = 'v2';
  response = await docketRoute.POST(
    request(
      { signerName: 'Customer', signatureData: 'data:image/png;base64,AAAA', version: 'v1' },
      'POST'
    ),
    { params: Promise.resolve({ id }) }
  );
  assert.equal(response.status, 400);
  assert.equal(queries.at(-1).sql, 'ROLLBACK');
  reset();
  response = await docketRoute.POST(
    request(
      { signerName: 'Customer', signatureData: 'data:image/png;base64,AAAA', version: 'v1' },
      'POST'
    ),
    { params: Promise.resolve({ id }) }
  );
  assert.equal(response.status, 200);
  assert.ok(queries.some(q => q.sql.includes('correction_pending=false')));
  assert.ok(released >= 10);
  console.log(
    'PASS: admin-only access, allowed fields, stale-edit protection, originals archived before mutation, linked deletion blocked, dates validated, stock balances corrected/reversed, signed originals preserved and fresh signature version checks.'
  );
})().catch(e => {
  console.error(e);
  process.exitCode = 1;
});
