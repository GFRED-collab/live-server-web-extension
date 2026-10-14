const assert=require('node:assert/strict'),fs=require('node:fs');
const {loadTs}=require('./test-load-ts.cjs');
let role='customer',active=true,queries=[],audits=[];
const id='11111111-1111-4111-8111-111111111111',clientId='22222222-2222-4222-8222-222222222222';
const auth=loadTs('lib/auth.ts',name=>{
 if(name==='next/headers')return{cookies:async()=>({get:()=>({value:Buffer.alloc(32,1).toString('base64url')})})};
 if(name.endsWith('/db'))return{getDb:()=>({query:async()=>({rows:active?[{id,role,remaining_ms:900000}]:[]})})};
});
let rollback=false,fail=false,linked=true;
const db={release(){},async query(sql,params){queries.push({sql,params});if(sql==='ROLLBACK')rollback=true;if(fail&&sql.includes('FROM contracts'))throw Error('Simulated failure');
 if(sql.includes('FROM clients c JOIN users'))return{rowCount:linked?1:0,rows:linked?[{id:clientId,name:'Own clinic'}]:[]};
 if(sql.startsWith('INSERT INTO users')||sql.startsWith('UPDATE users'))return{rowCount:1,rows:[{id}]};
 return{rowCount:0,rows:[]};}};
const overrides=name=>{
 if(name.endsWith('/auth'))return{requireUser:auth.requireUser};
 if(name.endsWith('/db'))return{getDb:()=>({connect:async()=>db,query:db.query})};
 if(name==='bcryptjs')return{default:{hash:async()=> 'HASH'}};
 if(name.endsWith('/audit'))return{writeAudit:async(...args)=>audits.push(args)};
};
const portal=loadTs('app/api/customer-portal/route.ts',overrides),accounts=loadTs('app/api/customer-accounts/route.ts',overrides);
const make=(method,body)=>new Request('https://reports.example/api/customer-accounts',{method,headers:{'content-type':'application/json'},body:JSON.stringify(body)});
(async()=>{
 assert.equal((await auth.requireUser()).response.status,403);
 assert.equal((await auth.requireUser(['super_user','engineer'])).response.status,403);
 assert.equal((await auth.requireUser(['customer'])).response,null);
 assert.equal((await accounts.GET()).status,403);assert.equal(queries.length,0);
 assert.equal((await portal.GET(new Request('https://reports.example/api/customer-portal?clientId=other'))).status,200);
 const selects=queries.filter(q=>q.sql.includes('JOIN users u'));
 assert.equal(selects.length,4);for(const q of selects){assert.deepEqual(Array.from(q.params),[id]);assert.match(q.sql,/u\.id=\$1 AND u\.role='customer' AND u\.active=true/);}
 const history=selects.find(q=>q.sql.includes('FROM service_visit_devices'));
 assert.match(history.sql,/v\.status='finalized'/);assert.match(history.sql,/s\.signer_role='engineer'/);assert.match(history.sql,/s\.signer_role='client'/);
 assert.ok(!/sd\.comments|sd\.values|ct\.notes|d\.notes|p\.notes|signature_data|v\.summary|v\.recommendations/.test(history.sql));
 linked=false;assert.equal((await portal.GET()).status,403);linked=true;
 fail=true;rollback=false;assert.equal((await portal.GET()).status,400);assert.equal(rollback,true);fail=false;
 role='engineer';assert.equal((await portal.GET()).status,403);
 role='super_user';queries=[];
 const body={name:'Customer',email:'customer@example.com',clientId,password:'GoodPassword123!',canExport:true,active:true};
 assert.equal((await accounts.POST(make('POST',body))).status,201);
 assert.ok(queries.some(q=>q.sql.includes("'customer'")&&q.sql.startsWith('INSERT INTO users')));
 queries=[];assert.equal((await accounts.PATCH(make('PATCH',{...body,id,password:''}))).status,200);
 assert.ok(queries.some(q=>q.sql.includes("WHERE id=$1 AND role='customer'")));
 assert.ok(queries.some(q=>q.sql==='DELETE FROM sessions WHERE user_id=$1'));
 assert.ok(!JSON.stringify(audits).includes('GoodPassword123!'));assert.ok(!JSON.stringify(audits).includes('HASH'));
 queries=[];assert.equal((await accounts.POST(make('POST',{...body,clientId:'other'}))).status,400);assert.equal(queries.length,0);
 active=false;assert.equal((await portal.GET()).status,401);
 const migration=fs.readFileSync('database/migrations/018-customer-client-access.sql','utf8');assert.match(migration,/REFERENCES clients\(id\) ON DELETE RESTRICT/);assert.match(migration,/client_id IS NOT NULL/);
 console.log('PASS customer opt-in auth, staff denial, account-derived tenant queries, dual-signature/finalized guards, private-field exclusion, rollback, admin-only account management and session revocation (database simulated).');
})().catch(e=>{console.error(e);process.exitCode=1});
