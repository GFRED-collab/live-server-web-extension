const assert = require('node:assert/strict');
const fs = require('node:fs');
const ts = require('typescript');
const vm = require('node:vm');
let user = { id: '11111111-1111-4111-8111-111111111111', displayName: 'Test', role: 'engineer' };
const queries = [];
function loadRoute(path) {
  const code = ts.transpileModule(fs.readFileSync(path, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 }
  }).outputText;
  const exports = {};
  vm.runInNewContext(code, {
    exports,
    Response,
    Request,
    URL,
    console,
    require(name) {
      if (name.endsWith('/auth'))
        return {
          requireUser: async roles =>
            !user
              ? { response: Response.json({ error: 'Authentication required' }, { status: 401 }) }
              : roles && !roles.includes(user.role)
                ? { response: Response.json({ error: 'Forbidden' }, { status: 403 }) }
                : { user }
        };
      if (name.endsWith('/db'))
        return {
          getDb: () => ({
            query: async (sql, params) => {
              queries.push({ sql, params });
              return { rows: [], rowCount: 0 };
            }
          })
        };
      if (name.endsWith('/audit')) return { writeAudit: async () => {} };
      if (name.endsWith('/http'))
        return {
          jsonObject: r => r.json(),
          errorResponse: e => Response.json({ error: e.message }, { status: 400 })
        };
      throw Error(name);
    }
  });
  return exports;
}
(async () => {
  const repairs = loadRoute('app/api/repairs/route.ts');
  for (const body of [
    { reportedFault: '', receivedDate: '2026-10-02', deviceName: 'Device' },
    { reportedFault: 'Fault', receivedDate: '2026-02-30', deviceName: 'Device' },
    {
      reportedFault: 'Fault',
      receivedDate: '2026-10-02',
      completedDate: '2026-09-30',
      deviceName: 'Device'
    },
    {
      reportedFault: 'Fault',
      receivedDate: '2026-10-02',
      deviceName: 'Device',
      clientId: 'not-a-uuid'
    }
  ]) {
    const response = await repairs.POST(
      new Request('http://test/api/repairs', { method: 'POST', body: JSON.stringify(body) })
    );
    assert.equal(response.status, 400);
  }
  assert.equal(queries.length, 0, 'Invalid inputs must not reach the database');
  const stock = loadRoute('app/api/stock/route.ts');
  await stock.GET();
  assert.equal(queries.length, 4);
  for (const query of queries.slice(1))
    assert.deepEqual(
      Array.from(query.params),
      [user.id],
      'Engineer queries must be scoped to self'
    );
  user = { ...user, role: 'department_user' };
  assert.equal((await stock.GET()).status, 403);
  user = null;
  assert.equal((await repairs.GET()).status, 401);
  assert.equal((await stock.GET()).status, 401);
  console.log(
    'PASS: repair validation rejects malformed input before SQL; stock API role and ownership checks; unauthenticated access denied.'
  );
})().catch(e => {
  console.error(e);
  process.exitCode = 1;
});
