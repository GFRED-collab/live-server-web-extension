import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile,readdir,cp} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFileSync} from 'node:child_process';
import {createApp} from '../server.mjs';

test('OCC durable workspace and authorisation',async t=>{
  const dir=await mkdtemp(join(tmpdir(),'occ-test-'));let app,base;
  async function start(){app=createApp({dataDir:dir,origin:'http://occ.test',setupToken:'test-setup-key',maxFile:1024,quota:2500});await new Promise(resolve=>app.server.listen(0,'127.0.0.1',resolve));base='http://127.0.0.1:'+app.server.address().port;}
  async function stop(){app.server.closeAllConnections();await new Promise(resolve=>app.server.close(resolve));}
  async function request(path,{method='GET',body,user,raw,origin='http://occ.test',csrf=true}={}){const headers={Origin:origin};if(user){headers.Cookie=user.cookie;if(csrf)headers['X-CSRF-Token']=user.csrf;}if(body!==undefined)headers['Content-Type']='application/json';if(raw!==undefined)headers['Content-Type']='application/octet-stream';const response=await fetch(base+'/api'+path,{method,headers,body:raw!==undefined?raw:body===undefined?undefined:JSON.stringify(body)});const type=response.headers.get('content-type');const value=type?.startsWith('application/json')?await response.json():Buffer.from(await response.arrayBuffer());return {status:response.status,body:value,headers:response.headers};}
  async function login(email,password){const r=await request('/login',{method:'POST',body:{email,password}});assert.equal(r.status,200,JSON.stringify(r.body));return {cookie:r.headers.get('set-cookie').split(';')[0],csrf:r.body.csrf,id:r.body.user.id,mustChange:r.body.user.mustChangePassword};}
  const adminPassword='Admin-password-2026!',temporary='Temporary-password-2026!',staffPassword='Changed-password-2026!';let admin,manager,contributor,viewer,root,privateFolder,sub,fileId;
  async function createUser(label,role){const r=await request('/users',{method:'POST',user:admin,body:{name:label,email:label.toLowerCase()+'@example.test',password:temporary,account:'standard',grants:{[root]:role}}});assert.equal(r.status,201,JSON.stringify(r.body));const first=await login(label.toLowerCase()+'@example.test',temporary);assert.equal(first.mustChange,true);assert.equal((await request('/workspace',{user:first})).status,403);assert.equal((await request('/password',{method:'POST',user:first,body:{currentPassword:temporary,password:staffPassword}})).status,200);assert.equal((await request('/workspace',{user:first})).status,401);return login(label.toLowerCase()+'@example.test',staffPassword);}
  await start();
  try{
    await t.test('first Super User setup is token-gated and single-use',async()=>{
      assert.equal((await request('/status')).body.setupRequired,true);
      assert.equal((await request('/setup',{method:'POST',body:{token:'wrong',name:'Admin',email:'admin@example.test',password:adminPassword}})).status,403);
      assert.equal((await request('/setup',{method:'POST',body:{token:'test-setup-key',name:'Admin',email:'admin@example.test',password:adminPassword}})).status,201);
      assert.equal((await request('/setup',{method:'POST',body:{token:'test-setup-key'}})).status,409);
      assert.equal((await request('/status')).body.setupRequired,false);assert.ok(!(await readdir(dir)).includes('setup-token'));
      admin=await login('admin@example.test',adminPassword);assert.match(admin.cookie,/occ_session=/);assert.match((await request('/me',{user:admin})).headers.get('cache-control'),/no-store/);
    });
    await t.test('unauthenticated, cross-origin and CSRF mutations are rejected',async()=>{
      assert.equal((await request('/workspace')).status,401);
      assert.equal((await request('/folders',{method:'POST',user:admin,csrf:false,body:{name:'Bad'}})).status,403);
      assert.equal((await request('/folders',{method:'POST',user:admin,origin:'https://evil.test',body:{name:'Bad'}})).status,403);
      assert.equal((await request('/login',{method:'POST',origin:'https://evil.test',body:{email:'admin@example.test',password:adminPassword}})).status,403);
    });
    await t.test('folders persist and duplicate or traversal names are rejected',async()=>{
      const r=await request('/folders',{method:'POST',user:admin,body:{name:'Clinical resources'}});assert.equal(r.status,201);root=r.body.id;
      privateFolder=(await request('/folders',{method:'POST',user:admin,body:{name:'Private'}})).body.id;
      assert.equal((await request('/folders',{method:'POST',user:admin,body:{name:'CLINICAL RESOURCES'}})).status,409);
      assert.equal((await request('/folders',{method:'POST',user:admin,body:{name:'../escape'}})).status,400);
    });
    await t.test('account creation and required temporary-password replacement',async()=>{manager=await createUser('Manager','Manager');contributor=await createUser('Contributor','Contributor');viewer=await createUser('Viewer','Viewer');assert.equal((await request('/users',{method:'POST',user:manager,body:{}})).status,403);});
    await t.test('role restrictions apply to direct API calls',async()=>{
      assert.equal((await request('/folders',{method:'POST',user:contributor,body:{name:'Unauthorised root'}})).status,403);
      assert.equal((await request('/folders',{method:'POST',user:viewer,body:{name:'No',parent:root}})).status,404);
      sub=(await request('/folders',{method:'POST',user:contributor,body:{name:'Nested',parent:root}})).body.id;assert.ok(sub);
      const state=(await request('/workspace',{user:viewer})).body;assert.ok(state.folders.some(f=>f.id===sub));assert.ok(!state.folders.some(f=>f.id===privateFolder));assert.ok(!JSON.stringify(state).includes('password_hash'));
      assert.equal((await request('/folders/'+root+'/grants',{method:'PUT',user:contributor,body:{grants:{}}})).status,404);
      assert.equal((await request('/folders/'+sub+'/grants',{method:'PUT',user:manager,body:{grants:{}}})).status,400);
    });
    await t.test('any-file upload and original-byte download survive restart',async()=>{
      const data=Buffer.from([0,255,1,2,3,99]);const r=await request('/files?folder='+sub+'&name='+encodeURIComponent('Résumé.bin'),{method:'POST',user:contributor,raw:data});assert.equal(r.status,201,JSON.stringify(r.body));fileId=r.body.id;
      assert.deepEqual((await request('/files/'+fileId+'/content',{user:viewer})).body,data);
      assert.equal((await request('/files?folder='+sub+'&name=blocked.txt',{method:'POST',user:viewer,raw:'no'})).status,404);
      assert.equal((await request('/files?folder='+sub+'&name='+encodeURIComponent('Résumé.bin'),{method:'POST',user:contributor,raw:'duplicate'})).status,409);
      await stop();await start();assert.deepEqual((await request('/files/'+fileId+'/content',{user:viewer})).body,data);
      assert.equal((await request('/status')).body.setupRequired,false);
    });
    await t.test('offline backup restores files and users on a new instance',async()=>{
      const restored=await mkdtemp(join(tmpdir(),'occ-restore-'));let copy;
      await stop();
      try{
        await cp(dir,restored,{recursive:true});
        const verification=JSON.parse(execFileSync(process.execPath,['scripts/verify-data.mjs',restored],{encoding:'utf8'}));assert.equal(verification.ok,true);assert.equal(verification.files,1);
        execFileSync(process.execPath,['scripts/expire-sessions.mjs',restored]);
        copy=createApp({dataDir:restored,origin:'http://occ.test',maxFile:1024,quota:2500});await new Promise(r=>copy.server.listen(0,'127.0.0.1',r));
        const address='http://127.0.0.1:'+copy.server.address().port;
        const oldSession=await fetch(address+'/api/me',{headers:{Cookie:admin.cookie}});assert.equal(oldSession.status,401);await oldSession.arrayBuffer();
        const signed=await fetch(address+'/api/login',{method:'POST',headers:{Origin:'http://occ.test','Content-Type':'application/json'},body:JSON.stringify({email:'admin@example.test',password:adminPassword})});assert.equal(signed.status,200);await signed.json();
        const downloaded=await fetch(address+'/api/files/'+fileId+'/content',{headers:{Cookie:signed.headers.get('set-cookie').split(';')[0]}});assert.equal(downloaded.status,200);assert.deepEqual(Buffer.from(await downloaded.arrayBuffer()),Buffer.from([0,255,1,2,3,99]));
      }finally{if(copy){copy.server.closeAllConnections();await new Promise(r=>copy.server.close(r));}await rm(restored,{recursive:true,force:true});await start();}
    });
    await t.test('filename MIME spoofing cannot inline active content',async()=>{
      const f=(await request('/files?folder='+root+'&name=not-a-pdf.pdf',{method:'POST',user:contributor,raw:'<script>alert(1)</script>'})).body.id;const response=await request('/files/'+f+'/content?inline=1',{user:viewer});assert.equal(response.status,200);assert.equal(response.headers.get('content-type'),'application/octet-stream');assert.match(response.headers.get('content-disposition'),/^attachment/);assert.match(response.headers.get('content-security-policy'),/sandbox/);
    });
    await t.test('size and workspace quota limits clean up unfinished files',async()=>{
      assert.equal((await request('/files?folder='+root+'&name=large.bin',{method:'POST',user:contributor,raw:Buffer.alloc(1025)})).status,413);
      assert.equal((await request('/files?folder='+root+'&name=one.bin',{method:'POST',user:contributor,raw:Buffer.alloc(1024)})).status,201);
      assert.equal((await request('/files?folder='+root+'&name=two.bin',{method:'POST',user:contributor,raw:Buffer.alloc(1024)})).status,201);
      assert.equal((await request('/files?folder='+root+'&name=three.bin',{method:'POST',user:contributor,raw:Buffer.alloc(1024)})).status,413);
      assert.ok(!(await readdir(join(dir,'blobs'))).some(f=>f.endsWith('.tmp')));
      assert.equal((await readdir(join(dir,'blobs'))).length,app.db.prepare('SELECT COUNT(*) n FROM files').get().n);
    });
    await t.test('rename, moves, hierarchy cycles and deletion enforce role access',async()=>{
      assert.equal((await request('/files/'+fileId,{method:'PATCH',user:contributor,body:{name:'forbidden.bin'}})).status,404);
      assert.equal((await request('/files/'+fileId,{method:'PATCH',user:manager,body:{name:'Renamed.bin'}})).status,200);
      assert.equal((await request('/files/'+fileId,{method:'PATCH',user:manager,body:{folder:privateFolder}})).status,404);
      assert.equal((await request('/folders/'+root,{method:'PATCH',user:manager,body:{parent:sub}})).status,400);
      assert.equal((await request('/folders/'+sub,{method:'DELETE',user:contributor})).status,404);
    });
    await t.test('revocation blocks existing sessions and inherited direct links immediately',async()=>{
      assert.equal((await request('/folders/'+root+'/grants',{method:'PUT',user:manager,body:{grants:{[manager.id]:'Manager',[contributor.id]:'Contributor'}}})).status,200);
      assert.equal((await request('/files/'+fileId+'/content',{user:viewer})).status,404);assert.equal((await request('/workspace',{user:viewer})).body.folders.length,0);
      assert.equal((await request('/folders/'+root+'/grants',{method:'PUT',user:admin,body:{grants:{[manager.id]:'Manager',[contributor.id]:'Contributor',[viewer.id]:'Viewer'}}})).status,200);
    });
    await t.test('deactivation and password reset invalidate established sessions',async()=>{
      assert.equal((await request('/users/'+viewer.id,{method:'PATCH',user:admin,body:{active:false}})).status,200);
      assert.equal((await request('/files/'+fileId+'/content',{user:viewer})).status,401);
      assert.equal((await request('/login',{method:'POST',body:{email:'viewer@example.test',password:staffPassword}})).status,401);
      assert.equal((await request('/users/'+manager.id,{method:'PATCH',user:admin,body:{password:'New-temporary-password!'}})).status,200);
      assert.equal((await request('/workspace',{user:manager})).status,401);
      assert.equal((await request('/users/'+admin.id,{method:'PATCH',user:admin,body:{active:false}})).status,400);
    });
    await t.test('folder deletion cascades metadata and removes stored files',async()=>{
      assert.equal((await request('/folders/'+root,{method:'DELETE',user:admin})).status,200);
      assert.equal(app.db.prepare('SELECT COUNT(*) n FROM files').get().n,0);assert.equal((await readdir(join(dir,'blobs'))).length,0);
      assert.equal((await request('/files/'+fileId+'/content',{user:admin})).status,404);
    });
    await t.test('audit trail excludes passwords and sessions expire',async()=>{
      const events=app.db.prepare('SELECT * FROM audit').all();assert.ok(events.some(e=>e.action==='folder.access_changed'));assert.ok(events.some(e=>e.action==='file.uploaded'));assert.ok(!JSON.stringify(events).includes(adminPassword));assert.ok(!JSON.stringify(events).includes(temporary));
      app.db.prepare('UPDATE sessions SET last_seen=0 WHERE user_id=?').run(admin.id);assert.equal((await request('/workspace',{user:admin})).status,401);
      admin=await login('admin@example.test',adminPassword);assert.equal((await request('/logout',{method:'POST',user:admin})).status,200);assert.equal((await request('/workspace',{user:admin})).status,401);
    });
    await t.test('failed-login throttling persists across restart',async()=>{
      for(let i=0;i<10;i++)await request('/login',{method:'POST',body:{email:'nobody@example.test',password:'wrong-password'}});
      await stop();await start();assert.equal((await request('/login',{method:'POST',body:{email:'nobody@example.test',password:'wrong-password'}})).status,429);
    });
    await t.test('database integrity and foreign keys remain valid',async()=>{assert.equal(app.db.prepare('PRAGMA integrity_check').get().integrity_check,'ok');assert.equal(app.db.prepare('PRAGMA foreign_key_check').all().length,0);});
  }finally{await stop();await rm(dir,{recursive:true,force:true});}
});
