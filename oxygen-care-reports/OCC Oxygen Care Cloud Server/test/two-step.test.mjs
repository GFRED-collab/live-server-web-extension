import test from 'node:test';import assert from 'node:assert/strict';import {mkdtemp,rm} from 'node:fs/promises';import {join} from 'node:path';import {tmpdir} from 'node:os';import {execFileSync} from 'node:child_process';
import {createApp} from '../server.mjs';import {totp} from './sign-in-helper.mjs';

test('two-step sign-in: setup, codes, recovery, limits, and resets',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'occ-two-step-'));
 // Production refuses to sign anyone in without the encryption key.
 const keyless=createApp({dataDir:await mkdtemp(join(tmpdir(),'occ-keyless-')),origin:'https://occ.test',production:true,setupToken:'test'});
 await new Promise(r=>keyless.server.listen(0,'127.0.0.1',r));
 const kb='http://127.0.0.1:'+keyless.server.address().port,kh={Origin:'https://occ.test','Content-Type':'application/json'};
 await fetch(kb+'/api/setup',{method:'POST',headers:kh,body:JSON.stringify({token:'test',name:'Admin',email:'admin@test.com',password:'Strong-password-2026!'})});
 const refused=await fetch(kb+'/api/login',{method:'POST',headers:kh,body:JSON.stringify({email:'admin@test.com',password:'Strong-password-2026!'})});
 assert.equal(refused.status,503);assert.match((await refused.json()).error,/not configured/);
 keyless.server.closeAllConnections();await new Promise(r=>keyless.server.close(r));await rm(keyless.dataDir,{recursive:true,force:true});

 const app=createApp({dataDir:dir,origin:'http://occ.test',setupToken:'test'});await new Promise(r=>app.server.listen(0,'127.0.0.1',r));const base='http://127.0.0.1:'+app.server.address().port;
 const post=async(path,data,cookie,csrf)=>{const r=await fetch(base+'/api'+path,{method:'POST',headers:{Origin:'http://occ.test','Content-Type':'application/json',...(cookie?{Cookie:cookie}:{}),...(csrf?{'X-CSRF-Token':csrf}:{})},body:JSON.stringify(data)});return {status:r.status,data:await r.json(),cookie:r.headers.get('set-cookie')||''};};
 const password=(email,pass)=>post('/login',{email,password:pass}).then(r=>({...r,challenge:r.cookie.split(';')[0]}));
 const verify=(challenge,code)=>post('/login/verify',{code},challenge).then(r=>({...r,session:r.cookie.split(';')[0]}));
 const me=cookie=>fetch(base+'/api/me',{headers:{Cookie:cookie}}).then(r=>r.status);
 const step=()=>Math.floor(Date.now()/30000);
 try{
  await post('/setup',{token:'test',name:'Admin',email:'admin@test.com',password:'Strong-password-2026!'});
  // 1. A correct password alone does not sign anyone in.
  const first=await password('admin@test.com','Strong-password-2026!');
  assert.equal(first.status,200);assert.equal(first.data.step,'totp_setup');assert.equal(first.data.csrf,undefined);
  assert.match(first.cookie,/^occ_challenge=[^;]+; HttpOnly; SameSite=Strict/);assert.doesNotMatch(first.cookie,/occ_session/);
  assert.match(first.data.otpauthUrl,/^otpauth:\/\/totp\/Irish%20Hospital%20Supplies%20Cloud%3Aadmin%40test\.com\?secret=/);assert.match(first.data.qrSvg,/^<svg/);
  assert.equal(await me(first.challenge.replace('occ_challenge','occ_session')),401);
  // 2. Setup: a wrong code is refused; the right one signs in and issues recovery codes.
  const key=first.data.key;assert.equal((await verify(first.challenge,'000000')).status,401);
  const done=await verify(first.challenge,totp(key,step()));assert.equal(done.status,200,JSON.stringify(done.data));
  assert.equal(done.data.recoveryCodes.length,10);assert.equal(done.data.user.mfaEnabled,true);assert.equal(await me(done.session),200);
  assert.equal((await verify(first.challenge,totp(key,step()+1))).data.restart,true,'a challenge is used once');
  const recovery=done.data.recoveryCodes,used=step();
  // 3. Later sign-ins never show the key again, and the same code can't be replayed.
  const second=await password('admin@test.com','Strong-password-2026!');assert.equal(second.data.step,'totp');assert.equal(second.data.key,undefined);
  assert.equal((await verify(second.challenge,totp(key,used))).status,401);assert.equal((await verify(second.challenge,totp(key,used+1))).status,200);
  // 4. A recovery code works once, in any case or spacing.
  const third=await password('admin@test.com','Strong-password-2026!');const viaRecovery=await verify(third.challenge,recovery[0].toLowerCase().replace('-',' '));
  assert.equal(viaRecovery.status,200);assert.equal(viaRecovery.data.recoveryCodesLeft,9);
  const fourth=await password('admin@test.com','Strong-password-2026!');assert.equal((await verify(fourth.challenge,recovery[0])).status,401);
  // 5. Five wrong codes end that sign-in; unknown sign-ins start again too.
  for(let i=2;i<=4;i++)assert.equal((await verify(fourth.challenge,'123456')).status,401);
  const fifth=await verify(fourth.challenge,'123456');assert.equal(fifth.data.restart,true);assert.match(fifth.cookie,/^occ_challenge=;/);
  assert.equal((await verify(fourth.challenge,recovery[1])).data.restart,true);assert.equal((await verify('occ_challenge=nope','123456')).data.restart,true);
  // 6. Ten wrong codes in 15 minutes block codes for that account, even with a new sign-in.
  for(let i=0;i<5;i++){const again=await password('admin@test.com','Strong-password-2026!');assert.equal((await verify(again.challenge,'123456')).status,401);}
  const blocked=await password('admin@test.com','Strong-password-2026!');const refusedCode=await verify(blocked.challenge,recovery[1]);assert.equal(refusedCode.status,429);assert.equal(refusedCode.data.restart,true);
  app.db.prepare('DELETE FROM failures').run();
  // 7. Resets: a Super User resets someone else, not themselves; a standard user can't.
  const admin=await verify((await password('admin@test.com','Strong-password-2026!')).challenge,recovery[2]);const adminCsrf=admin.data.csrf;
  assert.equal((await post('/users',{name:'Staff',email:'staff@test.com',password:'Temporary-password!',account:'standard',grants:{}},admin.session,adminCsrf)).status,201);
  const staffFirst=await password('staff@test.com','Temporary-password!');assert.equal(staffFirst.data.step,'totp_setup');
  const staff=await verify(staffFirst.challenge,totp(staffFirst.data.key,step()));assert.equal(staff.data.user.mustChangePassword,true);
  const staffId=staff.data.user.id,adminId=admin.data.user.id;
  const listed=app.db.prepare('SELECT mfa_secret,mfa_recovery FROM users WHERE id=?').get(staffId);assert.ok(listed.mfa_secret&&!listed.mfa_secret.includes(staffFirst.data.key.replace(/ /g,'')),'keys are stored encrypted');
  const del=(id,cookie,csrf)=>fetch(base+`/api/users/${id}/mfa`,{method:'DELETE',headers:{Origin:'http://occ.test',Cookie:cookie,'X-CSRF-Token':csrf}}).then(r=>r.status);
  assert.equal(await del(adminId,staff.session,staff.data.csrf),403);assert.equal(await del(adminId,admin.session,adminCsrf),400);
  assert.equal(await del(staffId,admin.session,adminCsrf),200);assert.equal(await me(staff.session),401,'a reset signs the person out');
  assert.equal((await password('staff@test.com','Temporary-password!')).data.step,'totp_setup');
  // 8. Workspace user lists show who has set up, without exposing keys.
  const ws=await (await fetch(base+'/api/workspace',{headers:{Cookie:admin.session}})).json();
  assert.equal(ws.users.find(u=>u.id===adminId).mfaEnabled,true);assert.equal(ws.users.find(u=>u.id===staffId).mfaEnabled,false);assert.doesNotMatch(JSON.stringify(ws),/mfa_secret|mfa_recovery/);
  // 9. The emergency script clears a Super User's authenticator from the server.
  execFileSync(process.execPath,['scripts/reset-mfa.mjs','admin@test.com',dir]);
  assert.equal(await me(admin.session),401);assert.equal((await password('admin@test.com','Strong-password-2026!')).data.step,'totp_setup');
  assert.throws(()=>execFileSync(process.execPath,['scripts/reset-mfa.mjs','nobody@test.com',dir],{stdio:'pipe'}),e=>e.stderr.toString().includes('No account'));
 }finally{app.server.closeAllConnections();await new Promise(r=>app.server.close(r));await rm(dir,{recursive:true,force:true});}
});

test('with TWO_STEP_SIGN_IN off, the password alone signs in and no key is needed',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'occ-two-step-off-'));const app=createApp({dataDir:dir,origin:'https://occ.test',production:true,setupToken:'test',twoStep:false});
 await new Promise(r=>app.server.listen(0,'127.0.0.1',r));const base='http://127.0.0.1:'+app.server.address().port,h={Origin:'https://occ.test','Content-Type':'application/json'};
 try{
  await fetch(base+'/api/setup',{method:'POST',headers:h,body:JSON.stringify({token:'test',name:'Admin',email:'admin@test.com',password:'Strong-password-2026!'})});
  const r=await fetch(base+'/api/login',{method:'POST',headers:h,body:JSON.stringify({email:'admin@test.com',password:'Strong-password-2026!'})});const body=await r.json();
  assert.equal(r.status,200);assert.equal(body.step,'none');assert.ok(body.csrf);assert.match(r.headers.get('set-cookie'),/^__Host-occ_session=/);
  assert.equal((await fetch(base+'/api/me',{headers:{Cookie:r.headers.get('set-cookie').split(';')[0]}})).status,200);
  assert.equal(app.db.prepare("SELECT detail FROM audit WHERE action='login.success'").get().detail,'{"secondStep":"off"}');
 }finally{app.server.closeAllConnections();await new Promise(r=>app.server.close(r));await rm(dir,{recursive:true,force:true});}
});
