const assert = require('node:assert/strict');
const { deflateRawSync } = require('node:zlib');
const { loadTs } = require('./test-load-ts.cjs');
const { unzipEntry } = loadTs('lib/workbook-zip.ts');
const { csvCell } = loadTs('lib/csv-export.ts');
const { validateClientName } = loadTs('lib/client-name.ts');
function archive(value, declaredSize = value.length) {
  const name = Buffer.from('xl/workbook.xml'), data = deflateRawSync(value);
  const local = Buffer.alloc(30); local.writeUInt32LE(0x04034b50); local.writeUInt16LE(8, 8); local.writeUInt16LE(name.length, 26);
  const central = Buffer.alloc(46); central.writeUInt32LE(0x02014b50); central.writeUInt16LE(8, 10); central.writeUInt32LE(data.length, 20); central.writeUInt32LE(declaredSize, 24); central.writeUInt16LE(name.length, 28);
  const end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50); end.writeUInt16LE(1, 10); end.writeUInt32LE(central.length + name.length, 12); end.writeUInt32LE(local.length + name.length + data.length, 16);
  const bytes = Buffer.concat([local, name, data, central, name, end]);
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.length);
}
(async () => {
  const { jsonObject } = loadTs('lib/http.ts');
  const request = (path, body, method = 'POST') => new Request('http://test' + path, {method, body: JSON.stringify(body)});
  const cases = [
    ['/api/appointments', 'POST', {title:'Visit 🏥'}],
    ['/api/appointments', 'POST', {notes:'Follow up 😀'}],
    ['/api/appointments', 'PATCH', {notes:'Edited 😀'}],
    ['/api/repairs', 'POST', {reportedFault:'Fault 🔧'}],
    ['/api/repairs', 'PATCH', {workCarriedOut:'Fixed 👍'}],
    ['/api/fieldwork', 'POST', {description:'Call out 🚨'}],
    ['/api/fieldwork', 'PATCH', {notes:'Follow up 📞'}],
    ['/api/reports', 'POST', {rows:[{Comments:'Checked ✅'}]}],
    ['/api/report-rows/test', 'PATCH', {fields:{Comments:'Checked ✅'}}],
    ['/api/stock/parts', 'PUT', {parts:[{name:'Valve 🔧'}]}],
    ['/api/stock/movements', 'POST', {detail:'Assigned 📦'}],
    ['/api/users', 'POST', {displayName:'Admin 😀', password:'Strong🔐Password123'}],
    ['/api/users/test', 'PATCH', {departmentName:'Team 😀'}],
    ['/api/admin/entries', 'PATCH', {fields:{notes:'Edited 😀'}}],
    ['/api/fields', 'POST', {name:'Status ✅'}],
    ['/api/reports', 'POST', {rows:[{'Column 😀':'text'}]}],
    ['/api/reports', 'POST', {rows:[{password:'Bypass 😀'}]}],
  ];
  let databaseCalls = 0;
  for (const [path, method, body] of cases) {
    await assert.rejects(jsonObject(request(path, body, method)), /Emojis are not allowed/);
    const modulePath = path.replace(/\/test$/, '/[id]');
    const route = loadTs('app' + modulePath + '/route.ts', (name) => {
      if (name.endsWith('/auth')) return {requireUser:async () => ({user:{id:'admin',role:'super_user'}})};
      if (name.endsWith('/db')) return {getDb:() => {databaseCalls++; throw Error('Unexpected database access');}};
      if (name.endsWith('/audit')) return {writeAudit:async () => {}};
      if (name === 'bcryptjs') return {default:{}};
    });
    const result = await route[method](request(path, body, method), {params:Promise.resolve({id:'test'})});
    assert.equal(result.status,400, path);
    assert.match((await result.json()).error,/Emojis are not allowed/,path);
  }
  assert.equal(databaseCalls,0,'Emoji entries must be rejected before database access');
  for (const path of ['/api/auth/login','/api/users','/api/users/test']) {
    assert.equal((await jsonObject(request(path,{password:'Strong🔐Password123',displayName:'Renée'}))).password,'Strong🔐Password123');
    await assert.rejects(jsonObject(request(path,{fields:{password:'Hidden 😀'}})),/Emojis are not allowed/);
  }
  for (const name of ['Hôpital 123', '東京', 'مستشفى', "O’Brien & Sons", 'Room #1 *', '09:00 – 17:00']) {
    assert.equal((await jsonObject(request('/api/appointments',{title:name}))).title,name);
  }
  // Iterative traversal must handle deeply nested untrusted JSON safely.
  let nested = '😀'; for(let depth=0;depth<2000;depth++) nested = {value:nested};
  await assert.rejects(jsonObject(request('/api/reports',{rows:[nested]})),/Emojis are not allowed/);
  console.log('PASS emoji rejection across all requested routes/imports/admin edits before SQL; credential exemptions and international text preserved.');
  for (const name of ['Clinic 😀', '🏥 Hospital', '🇮🇪 Clinic', 'Clinic 1️⃣', 'Clinic 👍🏽', 'Clinic 👩‍⚕️']) assert.throws(() => validateClientName(name), /Emojis are not allowed/);
  for (const name of ['Hôpital Saint-Joseph', "O’Brien & Sons (Clinic 123)", '東京クリニック', 'مستشفى']) assert.equal(validateClientName(name), name);
  assert.throws(() => validateClientName('  '), /required/);
  let queries = 0;
  const clients = loadTs('app/api/clients/route.ts', (name) => {
    if (name.endsWith('/auth')) return {requireUser: async () => ({user:{id:'admin'}})};
    if (name.endsWith('/db')) return {getDb: () => ({query:async () => { queries++; return {rows:[{id:'client'}]}; }})};
    if (name.endsWith('/audit')) return {writeAudit:async () => {}};
    if (name.endsWith('/http')) return {jsonObject:r=>r.json(),errorResponse:e=>Response.json({error:e.message},{status:400})};
  });
  const rejected = await clients.POST(new Request('http://test/api/clients',{method:'POST',body:JSON.stringify({name:'Clinic 🏥'})}));
  assert.equal(rejected.status,400); assert.equal(queries,0);
  assert.match((await rejected.json()).error,/Emojis are not allowed/);
  assert.equal((await clients.POST(new Request('http://test/api/clients',{method:'POST',body:JSON.stringify({name:'Hôpital 123'})}))).status,201);
  console.log('PASS emoji client-name rejection before SQL and international-name acceptance.');
  assert.equal(await unzipEntry(archive(Buffer.from('<workbook/>')), 'xl/workbook.xml'), '<workbook/>');
  await assert.rejects(unzipEntry(new ArrayBuffer(22), 'xl/workbook.xml'), /Invalid workbook/);
  await assert.rejects(unzipEntry(archive(Buffer.from('small'), 21 * 1024 * 1024), 'xl/workbook.xml'), /oversized/);
  await assert.rejects(unzipEntry(archive(Buffer.alloc(21 * 1024 * 1024), 1), 'xl/workbook.xml'), /safe size limit/);
  await assert.rejects(unzipEntry(archive(Buffer.from('small'), 1), 'xl/workbook.xml'), /entry size/);
  for (const value of ['=SUM(A1)', '  +cmd', '\t@formula', '\r-1']) assert.equal(csvCell(value), "'" + value);
  assert.equal(csvCell('normal text'), 'normal text');
  console.log('PASS bounded workbook decompression, malformed archives and whitespace-prefixed CSV formulas.');
})().catch((error) => { console.error(error); process.exitCode = 1; });
