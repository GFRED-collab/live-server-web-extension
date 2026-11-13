import test from 'node:test';import assert from 'node:assert/strict';import {mkdtemp,rm} from 'node:fs/promises';import {join} from 'node:path';import {tmpdir} from 'node:os';
import {createApp,brands} from '../server.mjs';

const start=async(t,brand)=>{const dir=await mkdtemp(join(tmpdir(),'occ-brand-'));const app=createApp({dataDir:dir,origin:'http://occ.test',setupToken:'test',...(brand?{brand}:{})});await new Promise(r=>app.server.listen(0,'127.0.0.1',r));t.after(async()=>{app.server.closeAllConnections();await new Promise(r=>app.server.close(r));await rm(dir,{recursive:true,force:true});});return {base:'http://127.0.0.1:'+app.server.address().port};};
const page=async base=>(await fetch(base+'/')).text();
const meta=html=>JSON.parse(/<meta name="occ-brand" content="([^"]+)">/.exec(html)[1].replace(/&quot;/g,'"').replace(/&amp;/g,'&').replace(/&#39;/g,"'"));
const setUpAndSignIn=async base=>{const h={Origin:'http://occ.test','Content-Type':'application/json'};await fetch(base+'/api/setup',{method:'POST',headers:h,body:JSON.stringify({token:'test',name:'Admin',email:'admin@test.com',password:'Strong-password-2026!'})});return (await fetch(base+'/api/login',{method:'POST',headers:h,body:JSON.stringify({email:'admin@test.com',password:'Strong-password-2026!'})})).json();};

test('an install shows Irish Hospital Supplies unless OCC_BRAND says otherwise',async t=>{
 const {base}=await start(t);const html=await page(base);
 assert.match(html,/<title>IHS Cloud · Irish Hospital Supplies<\/title>/);assert.equal(meta(html).name,'Irish Hospital Supplies Cloud');
 const logo=await fetch(base+'/brand-logo');assert.equal(logo.headers.get('content-type'),'image/png');await logo.arrayBuffer();
 assert.match((await setUpAndSignIn(base)).otpauthUrl,/issuer=Irish%20Hospital%20Supplies%20Cloud/);
});

test('an Oxygen Care install shows its own name, logo and authenticator label',async t=>{
 const {base}=await start(t,'oxygen-care');const html=await page(base);
 assert.match(html,/<title>OCC · Oxygen Care Cloud<\/title>/);assert.doesNotMatch(html,/Irish Hospital Supplies/);
 assert.deepEqual(meta(html),brands['oxygen-care']);
 const logo=await fetch(base+'/brand-logo');assert.equal(logo.status,200);assert.equal(logo.headers.get('content-type'),'image/jpeg');await logo.arrayBuffer();
 assert.equal((await fetch(base+'/irish-hospital-supplies-logo.png')).status,404);
 const step=await setUpAndSignIn(base);assert.match(step.otpauthUrl,/^otpauth:\/\/totp\/Oxygen%20Care%20Cloud%3Aadmin%40test\.com\?/);assert.match(step.otpauthUrl,/issuer=Oxygen%20Care%20Cloud/);
});

test('an unknown brand stops the install from starting',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'occ-brand-bad-'));
 try{assert.throws(()=>createApp({dataDir:dir,origin:'http://occ.test',brand:'acme'}),/OCC_BRAND must be one of: ihs, oxygen-care/);}finally{await rm(dir,{recursive:true,force:true});}
});
