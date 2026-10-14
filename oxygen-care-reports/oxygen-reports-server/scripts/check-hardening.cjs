const assert=require('node:assert/strict');
const {loadTs}=require('./test-load-ts.cjs');
const {mutationError,MAX_JSON_BYTES}=loadTs('lib/request-security.ts');
const {jsonObject,errorResponse}=loadTs('lib/http.ts');
const make=(headers={},body='{}')=>new Request('https://reports.example/api/test',{method:'POST',headers:{origin:'https://reports.example','content-type':'application/json',...headers},body});
(async()=>{
 let idle=0,age=0,enabled=true,token=Buffer.alloc(32,1).toString('base64url'),cookieOptions;
 const sessionQueries=[];
 const sessionAuth=loadTs('lib/auth.ts',name=>{
  if(name==='next/headers')return{cookies:async()=>({get:()=>token?{value:token}:undefined,set:(_key,value,options)=>{token=value;cookieOptions=options;},delete:()=>{token='';}})};
  if(name.endsWith('/db'))return{getDb:()=>({query:async(sql,params)=>{
   sessionQueries.push({sql,params});
   if(sql.includes('FROM sessions s')||sql.startsWith('UPDATE sessions s')){
    assert.match(sql,/last_seen_at\s*>\s*now\(\)\s*-\s*interval '15 minutes'/);
    assert.match(sql,/created_at\s*>\s*now\(\)\s*-\s*interval '8 hours'/);
    const valid=idle<900000&&age<28800000&&enabled;
    if(valid&&sql.startsWith('UPDATE'))idle=0;
    return{rows:valid?[{id:'user',display_name:'User',role:'engineer',can_export:false,remaining_ms:Math.min(900000-idle,28800000-age)}]:[]};
   }
   return{rows:[],rowCount:1};
  }})};
 });
 for(let poll=0;poll<30;poll++){idle=poll*30000;assert.ok(await sessionAuth.currentUser());}
 assert.ok(sessionQueries.every(query=>!query.sql.startsWith('UPDATE')),'Polling must not renew idle time');
 idle=900000;assert.equal(await sessionAuth.currentUser(),null);assert.equal(await sessionAuth.recordSessionActivity(),null,'Expired sessions cannot be revived');
 idle=600000;assert.equal(await sessionAuth.recordSessionActivity(),900000);assert.equal(idle,0);
 age=28800000;assert.equal(await sessionAuth.currentUser(),null);assert.equal(await sessionAuth.recordSessionActivity(),null);
 age=28790000;idle=0;assert.equal(await sessionAuth.recordSessionActivity(),10000,'Activity cannot extend absolute expiry');
 age=0;enabled=false;assert.equal(await sessionAuth.currentUser(),null);assert.equal(await sessionAuth.recordSessionActivity(),null);enabled=true;
 const previous=token;await sessionAuth.createSession('user');assert.notEqual(token,previous);assert.equal(cookieOptions.httpOnly,true);assert.equal(cookieOptions.sameSite,'strict');assert.equal(cookieOptions.path,'/');
 assert.ok(cookieOptions.expires.getTime()-Date.now()<=28800000);
 assert.equal(cookieOptions.secure,process.env.NODE_ENV==='production');
 assert.ok(sessionQueries.some(query=>query.sql.startsWith('DELETE FROM sessions WHERE token_hash')));
 assert.ok(sessionQueries.every(query=>!query.params?.includes(previous)),'Raw session tokens must never reach SQL');
 await sessionAuth.deleteSession();assert.equal(token,'');
 console.log('PASS server idle/absolute boundaries, non-renewing polls, no expired-session revival, inactive-user rejection and token rotation/revocation. Database simulated.');
 assert.equal(mutationError(make()),null);
 assert.ok(mutationError(make({origin:'https://evil.example'})));
 assert.ok(mutationError(make({'sec-fetch-site':'cross-site'})));
 assert.ok(mutationError(make({origin:'null'})));
 assert.ok(mutationError(make({'content-type':'text/plain'})));
 assert.ok(mutationError(make({'content-length':String(MAX_JSON_BYTES+1)})));
 assert.equal(mutationError(make(), 'https://reports.example'),null);
 assert.ok(mutationError(make(), 'https://other.example'));
 assert.equal(mutationError(new Request('https://reports.example/api/test')),null);
 assert.equal((await jsonObject(make({},'{"name":"test"}'))).name,'test');
 for(const body of ['[]','null','{']) await assert.rejects(()=>jsonObject(make({},body)));
 try {await jsonObject(make({},'x'.repeat(MAX_JSON_BYTES+1)));assert.fail('Expected size limit');}
 catch(error){assert.equal(errorResponse(error).status,413);}
 assert.equal(errorResponse({code:'23505'}).status,409);
 let checks=0;
 const login=loadTs('app/api/auth/login/route.ts',name=>{
  if(name==='bcryptjs')return {default:{hashSync:()=> 'dummy',compare:async()=>{checks++;return false;}}};
  if(name.endsWith('/auth'))return {createSession:async()=>assert.fail('Invalid credentials created session')};
  if(name.endsWith('/audit'))return {writeAudit:async()=>{}};
  if(name.endsWith('/db'))return {getDb:()=>({query:async()=>({rows:[]})})};
 });
 for(let attempt=0;attempt<8;attempt++){
  const request=make({'x-forwarded-for':'spoof-'+attempt},JSON.stringify({email:'unknown@example.com',password:'Example123!'}));
  assert.equal((await login.POST(request)).status,401);
 }
 assert.equal((await login.POST(make({'x-forwarded-for':'different'},JSON.stringify({email:'unknown@example.com',password:'Example123!'})))).status,429);
 assert.equal(checks,8);
 assert.equal((await login.POST(make({},JSON.stringify({email:'other@example.com',password:'x'.repeat(73)})))).status,400);
 let revoked=false,hashes=0;
 const client={query:async(sql)=>{if(sql.startsWith('DELETE FROM sessions'))revoked=true;return {rows:[],rowCount:1};},release(){}};
 const users=loadTs('app/api/users/[id]/route.ts',name=>{
  if(name==='bcryptjs')return {default:{hash:async()=>{hashes++;return 'hashed';}}};
  if(name.endsWith('/auth'))return {requireUser:async()=>({user:{id:'admin'}})};
  if(name.endsWith('/audit'))return {writeAudit:async()=>{}};
  if(name.endsWith('/db'))return {getDb:()=>({connect:async()=>client})};
 });
 const edit=password=>users.PATCH(make({},JSON.stringify({role:'engineer',email:'user@example.com',displayName:'User',password})),{params:Promise.resolve({id:'user'})});
 assert.equal((await edit('short')).status,400);assert.equal(hashes,0);
 assert.equal((await edit('x'.repeat(73))).status,400);assert.equal(hashes,0);
 assert.equal((await edit('StrongPassword123!')).status,200);assert.equal(hashes,1);assert.equal(revoked,true);
 console.log('PASS same-origin writes, cross-site rejection, JSON content/size checks, streamed-body limit and validation responses.');
 console.log('PASS login throttling independent of forwarded IP, unknown-account bcrypt work, password-reset bounds and session revocation (database simulated).');
})().catch(e=>{console.error(e);process.exitCode=1});
