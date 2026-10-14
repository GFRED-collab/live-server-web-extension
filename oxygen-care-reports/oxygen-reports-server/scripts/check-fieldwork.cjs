const fs=require('fs'),vm=require('vm'),ts=require('typescript'),assert=require('node:assert/strict');
let user={id:'11111111-1111-4111-8111-111111111111',role:'engineer',displayName:'Engineer'};
const queries=[];let released=0;
const client={query:async(sql,params)=>{queries.push({sql,params});if(sql.includes('count(*)'))return{rows:[{count:1}],rowCount:1};if(sql.includes('SELECT id FROM users'))return{rows:[{id:user.id}],rowCount:1};if(sql.includes('INSERT INTO callouts'))return{rows:[{id:'created'}],rowCount:1};return{rows:[],rowCount:0};},release(){released++}};
const exportsObject={};vm.runInNewContext(ts.transpileModule(fs.readFileSync('app/api/fieldwork/route.ts','utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2020}}).outputText,{exports:exportsObject,Response,Request,URL,require(name){if(name.endsWith('/work-times'))return require('./test-load-ts.cjs').loadTs('lib/work-times.ts');if(name.endsWith('/auth'))return{requireUser:async()=>user?{user}:{response:Response.json({error:'Authentication required'},{status:401})}};if(name.endsWith('/db'))return{getDb:()=>({...client,connect:async()=>client})};if(name.endsWith('/audit'))return{writeAudit:async()=>{}};if(name.endsWith('/http'))return{jsonObject:r=>r.json(),errorResponse:e=>Response.json({error:e.message},{status:400})};throw Error(name);}});
const request=body=>new Request('http://test/api/fieldwork',{method:'POST',body:JSON.stringify(body)});
(async()=>{
const {loadTs}=require('./test-load-ts.cjs');let lookupQueries=[];
const lookup=loadTs('app/api/fieldwork/lookup/route.ts',name=>{
 if(name.endsWith('/auth'))return{requireUser:async()=>user?{user}:{response:Response.json({error:'Authentication required'},{status:401})}};
 if(name.endsWith('/db'))return{getDb:()=>({query:async(sql,params)=>{lookupQueries.push({sql,params});return{rows:Array.from({length:51},(_,i)=>({id:String(i)}))};}})};
});
for(const kind of ['clients','devices']){
 const result=await lookup.GET(new Request('http://test/api/fieldwork/lookup?kind='+kind+'&q=SN1&client='+user.id));
 assert.equal(result.status,200);const data=await result.json();assert.equal(data.items.length,50);assert.equal(data.hasMore,true);
 const query=lookupQueries.at(-1);assert.deepEqual(Array.from(query.params),['engineer',user.id,'%SN1%',user.id]);assert.match(query.sql,/contract_assignments/);assert.match(query.sql,/ca.user_id=\$2/);
 if(kind==='devices'){assert.match(query.sql,/cd.device_id=d.id/);assert.match(query.sql,/cd.removed_on IS NULL/);assert.match(query.sql,/d.status='active'/);}
}
const count=lookupQueries.length;assert.equal((await lookup.GET(new Request('http://test/api/fieldwork/lookup?kind=devices&client=bad'))).status,400);assert.equal(lookupQueries.length,count);
assert.equal((await lookup.GET(new Request('http://test/api/fieldwork/lookup?kind=unknown'))).status,400);
let response=await exportsObject.POST(request({kind:'callout',clientName:'Clinic',description:'Fault',deviceName:'Device',serialNumber:'SN1',assignedUserId:'22222222-2222-4222-8222-222222222222'}));assert.equal(response.status,201);assert.equal(queries.find(q=>q.sql.includes('INSERT INTO callouts')).params[4],user.id,'Non-admin assignment must be self');
assert.deepEqual(Array.from(queries.find(q=>q.sql.includes('INSERT INTO callouts')).params.slice(6)),['Device','SN1']);
response=await exportsObject.POST(request({kind:'docket',clientName:'Clinic',signerRole:'engineer',signatureData:'data:image/png;base64,AAAA'}));assert.equal(response.status,400);assert.equal(queries.at(-1).sql,'ROLLBACK');
response=await exportsObject.GET(new Request('http://test/api/fieldwork?notifications=1'));assert.equal((await response.json()).count,1);assert.equal(queries.at(-1).params[1],user.id);assert.match(queries.at(-1).sql,/assigned_user_id=\$2/);
user=null;assert.equal((await exportsObject.GET(new Request('http://test/api/fieldwork'))).status,401);assert.equal((await exportsObject.POST(request({}))).status,401);
assert.equal((await lookup.GET(new Request('http://test/api/fieldwork/lookup?kind=clients'))).status,401);
assert.equal(released,2);
console.log('PASS: assigned-user scoping, customer-only signatures, rollback/release on failure and unauthenticated access.');
})().catch(e=>{console.error(e);process.exitCode=1});
