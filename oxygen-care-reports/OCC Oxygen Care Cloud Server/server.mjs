import http from 'node:http';
import {createUpdatesApi} from './updates-api.mjs';
import {createGroupsApi} from './groups-api.mjs';
import {isIP} from 'node:net';
import {createCalendarApi} from './calendar-api.mjs';
import {createSyncApi,fileDigest} from './sync-api.mjs';
import { DatabaseSync } from 'node:sqlite';
import { randomBytes, randomUUID, createHash, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { mkdirSync, readFileSync, writeFileSync, existsSync, readdirSync, unlinkSync, openSync, readSync, closeSync, realpathSync } from 'node:fs';
import { open, unlink, rename } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const rawDerive = promisify(scrypt);
let kdfWork=0;
async function derive(password,salt,length,options){ensure(kdfWork<4,429,'Authentication is busy. Please retry shortly.');kdfWork++;try{return await rawDerive(password,salt,length,options)}finally{kdfWork--}}
const strongScrypt={N:32768,r:8,p:3,maxmem:64*1024*1024};
const hash = value => createHash('sha256').update(value).digest('hex');
const random = () => randomBytes(32).toString('base64url');
const now = () => Date.now();
const roles = ['Viewer', 'Contributor', 'Manager'];
class HttpError extends Error { constructor(status,message,code){super(message);this.status=status;this.code=code;} }
const fail = (status,message,code) => { throw new HttpError(status,message,code); };
const ensure = (condition,status,message,code) => { if(!condition)fail(status,message,code); };
function text(value,max=160){ensure(typeof value==='string'&&value.trim().length>0&&value.trim().length<=max,400,`Enter a value of 1–${max} characters.`);return value.trim();}
function name(value){const v=text(value);ensure(!/[\\/\x00-\x1f\x7f]/.test(v)&&v!=='.'&&v!=='..',400,'Names cannot contain slashes or control characters.');return v;}
function email(value){const v=text(value,254).toLowerCase();ensure(/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v),400,'Enter a valid email address.');return v;}
async function passwordHash(password,minimum=15){ensure(typeof password==='string'&&password.length>=minimum&&password.length<=128,400,`Use a password of ${minimum}–128 characters.`);const salt=randomBytes(16).toString('hex');const key=await derive(password,salt,64,strongScrypt);return `scrypt-v2:${salt}:${key.toString('hex')}`;}
async function passwordMatches(password,stored){if(typeof password!=='string'||password.length>128)return false;const [format,salt,key]=stored.split(':');if(!['scrypt','scrypt-v2'].includes(format)||!key||!/^[a-f0-9]{128}$/.test(key))return false;const actual=await derive(password,salt,64,format==='scrypt-v2'?strongScrypt:undefined);return timingSafeEqual(actual,Buffer.from(key,'hex'));}

const rootDir=dirname(fileURLToPath(import.meta.url));

export function createApp(options={}){
  const dataDir=resolve(options.dataDir||process.env.OCC_DATA_DIR||join(rootDir,'data'));
  const production=options.production??process.env.NODE_ENV==='production';
  const origin=options.origin||process.env.APP_ORIGIN||'http://127.0.0.1:3003';
  const originUrl=new URL(origin);
  ensure(origin===originUrl.origin,500,'APP_ORIGIN must be an origin without a path.');
  ensure(!production||originUrl.protocol==='https:',500,'Production requires an HTTPS APP_ORIGIN.');
  // Other addresses the app is also reached on (for example a public domain alongside the Tailscale one).
  const extraOrigins=(options.extraOrigins??String(process.env.APP_EXTRA_ORIGINS||'').split(',')).map(value=>value.trim()).filter(Boolean);
  for(const extra of extraOrigins){let url;try{url=new URL(extra);}catch{url=null;}ensure(url&&url.origin===extra&&(!production||url.protocol==='https:'),500,'APP_EXTRA_ORIGINS must list HTTPS origins without paths, separated by commas.');}
  const allowedOrigins=new Set([origin,...extraOrigins]);
  const maxFile=Number(options.maxFile??process.env.MAX_FILE_BYTES??100000000);
  const quota=Number(options.quota??process.env.STORAGE_QUOTA_BYTES??5000000000);
  ensure(Number.isSafeInteger(maxFile)&&maxFile>0&&Number.isSafeInteger(quota)&&quota>=maxFile,500,'Invalid storage limits.');
  mkdirSync(join(dataDir,'blobs'),{recursive:true,mode:0o700});
  const db=new DatabaseSync(join(dataDir,'occ.sqlite'));
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
    CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY,value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS users(id TEXT PRIMARY KEY,name TEXT NOT NULL,email TEXT NOT NULL COLLATE NOCASE UNIQUE,account TEXT NOT NULL CHECK(account IN ('super','standard')),active INTEGER NOT NULL DEFAULT 1,password_hash TEXT NOT NULL,must_change INTEGER NOT NULL DEFAULT 0,created INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS sessions(token_hash TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,csrf TEXT NOT NULL,created INTEGER NOT NULL,last_seen INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS folders(id TEXT PRIMARY KEY,name TEXT NOT NULL,parent TEXT REFERENCES folders(id) ON DELETE CASCADE,owner TEXT NOT NULL REFERENCES users(id),modified INTEGER NOT NULL);
    CREATE UNIQUE INDEX IF NOT EXISTS unique_folder_name ON folders(COALESCE(parent,''),LOWER(name));
    CREATE TABLE IF NOT EXISTS grants(folder_id TEXT NOT NULL REFERENCES folders(id) ON DELETE CASCADE,user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,role TEXT NOT NULL CHECK(role IN ('Viewer','Contributor','Manager')),PRIMARY KEY(folder_id,user_id));
    CREATE TABLE IF NOT EXISTS files(id TEXT PRIMARY KEY,name TEXT NOT NULL,folder TEXT NOT NULL REFERENCES folders(id) ON DELETE CASCADE,storage_key TEXT NOT NULL UNIQUE,size INTEGER NOT NULL,mime TEXT NOT NULL,owner TEXT NOT NULL REFERENCES users(id),modified INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS file_references(id TEXT PRIMARY KEY,name TEXT NOT NULL,folder TEXT NOT NULL REFERENCES folders(id) ON DELETE CASCADE,source TEXT NOT NULL CHECK(source IN ('occ','existing')),path TEXT NOT NULL,owner TEXT NOT NULL REFERENCES users(id),modified INTEGER NOT NULL);
    CREATE UNIQUE INDEX IF NOT EXISTS unique_reference_name ON file_references(folder,LOWER(name));
    CREATE UNIQUE INDEX IF NOT EXISTS unique_file_name ON files(folder,LOWER(name));
    CREATE TABLE IF NOT EXISTS audit(id INTEGER PRIMARY KEY AUTOINCREMENT,at INTEGER NOT NULL,actor TEXT,action TEXT NOT NULL,target TEXT,detail TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS failures(key TEXT PRIMARY KEY,count INTEGER NOT NULL,until_at INTEGER NOT NULL);
    INSERT OR IGNORE INTO settings VALUES('schema_version','1');`);
  const get=(sql,...args)=>db.prepare(sql).get(...args);
  const all=(sql,...args)=>db.prepare(sql).all(...args);
  const run=(sql,...args)=>db.prepare(sql).run(...args);
  const audit=(actor,action,target,detail={})=>run('INSERT INTO audit(at,actor,action,target,detail) VALUES(?,?,?,?,?)',now(),actor||null,action,target||null,JSON.stringify(detail));
  const transaction=fn=>{db.exec('BEGIN IMMEDIATE');try{const value=fn();db.exec('COMMIT');return value}catch(error){db.exec('ROLLBACK');throw error}};
  const setupRequired=()=>!get('SELECT id FROM users LIMIT 1');
  if(setupRequired()&&!get("SELECT value FROM settings WHERE key='setup_hash'")){
    const token=options.setupToken||random();
    writeFileSync(join(dataDir,'setup-token'),token+'\n',{mode:0o600});
    run("INSERT INTO settings VALUES('setup_hash',?)",hash(token));
  }
  // Crash recovery: incomplete uploads and file blobs with no database record.
  const known=new Set(all('SELECT storage_key FROM files').map(f=>f.storage_key));
  for(const entry of readdirSync(join(dataDir,'blobs')))if(!known.has(entry)&&/^[a-f0-9-]{36}(\.tmp)?$/.test(entry))unlinkSync(join(dataDir,'blobs',entry));
  const dummySalt=randomBytes(16).toString('hex');
  let uploads=0,authWork=0;
  const uploaders=new Set();
  const cookieName=production?'__Host-occ_session':'occ_session';
  const cookie=value=>`${cookieName}=${value}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${value?43200:0}${production?'; Secure':''}`;
  function session(req){const raw=(req.headers.cookie||'').split(';').map(x=>x.trim()).find(x=>x.startsWith(cookieName+'='))?.slice(cookieName.length+1);if(!raw)return null;const s=get('SELECT s.*,u.name,u.email,u.account,u.active,u.must_change FROM sessions s JOIN users u ON u.id=s.user_id WHERE token_hash=?',hash(raw));if(!s)return null;if(!s.active||s.created<now()-43200000||s.last_seen<now()-1800000){run('DELETE FROM sessions WHERE token_hash=?',s.token_hash);return null}if(req.url.split('?')[0]!=='/api/inbox/count')run('UPDATE sessions SET last_seen=? WHERE token_hash=?',now(),s.token_hash);return s;}
  const publicUser=u=>({id:u.id||u.user_id,name:u.name,email:u.email,role:u.account==='super'?'Super User':'Standard user',active:!!u.active,mustChangePassword:!!u.must_change});
  function rootFolder(id){let f=get('SELECT * FROM folders WHERE id=?',id);const seen=new Set();while(f?.parent){ensure(!seen.has(f.id),500,'Folder hierarchy is invalid.');seen.add(f.id);f=get('SELECT * FROM folders WHERE id=?',f.parent)}return f;}
  function permission(s,id){const active=s&&get('SELECT active,account,must_change FROM users WHERE id=?',s.user_id);if(!active?.active||active.must_change)return null;const f=rootFolder(id);if(!f)return null;return active.account==='super'?'Super User':get('SELECT role FROM grants WHERE folder_id=? AND user_id=?',f.id,s.user_id)?.role||null;}
  const permits=(s,id,action='view')=>{const role=permission(s,id);return action==='view'?!!role:action==='upload'?['Super User','Manager','Contributor'].includes(role):['Super User','Manager'].includes(role)};
  const requireFolder=(s,id,action='view')=>{ensure(typeof id==='string'&&permits(s,id,action),404,'Folder not found or access is unavailable.');return get('SELECT * FROM folders WHERE id=?',id)};
  const requireFile=(s,id,action='view')=>{const f=get('SELECT * FROM files WHERE id=?',id);ensure(f&&permits(s,f.folder,action),404,'File not found or access is unavailable.');return f};
  const requireSuper=s=>{const u=get('SELECT active,account,must_change FROM users WHERE id=?',s.user_id);ensure(u?.active&&!u.must_change&&u.account==='super',403,'Super User access is required.');};
  function subtree(id){return all('WITH RECURSIVE tree(id) AS (SELECT id FROM folders WHERE id=? UNION ALL SELECT f.id FROM folders f JOIN tree t ON f.parent=t.id) SELECT id FROM tree',id).map(f=>f.id)}
  function checkOrigin(req){ensure(allowedOrigins.has(req.headers.origin),403,'Request origin is not allowed.');}
  function json(res,status,data,headers={}){res.writeHead(status,{'Content-Type':'application/json; charset=utf-8',...headers});res.end(JSON.stringify(data));}
  async function body(req){ensure(req.headers['content-type']?.split(';')[0]==='application/json',415,'Send JSON for this request.');let size=0,chunks=[];for await(const chunk of req){size+=chunk.length;ensure(size<=65536,413,'Request is too large.');chunks.push(chunk)}if(req.occAuthenticated){const fresh=session(req);ensure(fresh,401,'Your session ended. Sign in again.');Object.assign(req.occSession,fresh);}let result;try{result=JSON.parse(Buffer.concat(chunks).toString())}catch{fail(400,'Invalid JSON request.')}ensure(result&&typeof result==='object'&&!Array.isArray(result),400,'Send a JSON object.');return result;}
  function clientAddress(req){const remote=req.socket.remoteAddress;const forwarded=process.env.TRUST_PROXY==='1'&&['127.0.0.1','::1','::ffff:127.0.0.1'].includes(remote)?String(req.headers['x-forwarded-for']||'').split(',').at(-1).trim():'';return isIP(forwarded)?forwarded:remote;}
  function rateKey(req,who=''){return hash(`${clientAddress(req)}:${who}`);}
  const requestRates=new Map();let lastCleanup=0;
  function requestGuard(req,res,url){
    ensure(req.url.length<=8192,414,'Request URL is too long.');
    if(now()-lastCleanup>60000){for(const [key,value]of requestRates)if(value.until<now())requestRates.delete(key);run('DELETE FROM failures WHERE until_at<?',now());lastCleanup=now();}
    const key=clientAddress(req),bucket=requestRates.get(key)||{count:0,until:now()+60000};if(bucket.until<now()){bucket.count=0;bucket.until=now()+60000;}ensure(requestRates.has(key)||requestRates.size<10000,503,'Server is busy.');bucket.count++;requestRates.set(key,bucket);if(bucket.count>1200){res.setHeader('Retry-After','60');ensure(false,429,'Too many requests. Please retry shortly.');}
    if(url.pathname.startsWith('/api/')){ensure(req.headers['sec-fetch-site']!=='cross-site',403,'Cross-site API access is not allowed.');ensure(!req.headers['content-encoding']||req.headers['content-encoding']==='identity',415,'Compressed request bodies are not supported.');}
  }
  function checkRate(key){const r=get('SELECT * FROM failures WHERE key=?',key);ensure(!r||r.count<10||r.until_at<now(),429,'Too many attempts. Please wait 15 minutes.');}
  function failedAttempt(key){if(!get('SELECT key FROM failures WHERE key=?',key)&&get('SELECT COUNT(*) n FROM failures').n>=10000)ensure(false,429,'Too many authentication attempts. Please retry later.');run('INSERT INTO failures VALUES(?,1,?) ON CONFLICT(key) DO UPDATE SET count=CASE WHEN until_at<? THEN 1 ELSE count+1 END,until_at=excluded.until_at',key,now()+900000,now());}
  function validateGrants(input){ensure(input&&typeof input==='object'&&!Array.isArray(input),400,'Invalid folder permissions.');for(const [id,role]of Object.entries(input)){ensure(roles.includes(role),400,'Invalid folder role.');const u=get('SELECT active,account FROM users WHERE id=?',id);ensure(u?.active&&u.account==='standard',400,'Choose an active standard user.');}return input;}
  function replaceGrants(folderId,grants){run('DELETE FROM grants WHERE folder_id=?',folderId);for(const [id,role]of Object.entries(grants))run('INSERT INTO grants VALUES(?,?,?)',folderId,id,role);}
  function validUserGrants(input){ensure(input&&typeof input==='object'&&!Array.isArray(input),400,'Invalid folder permissions.');for(const [id,role]of Object.entries(input)){const f=get('SELECT parent FROM folders WHERE id=?',id);ensure(f&&f.parent===null&&roles.includes(role),400,'Choose a top-level folder and valid role.');}return input;}
  function workspace(s){const fs=all('SELECT * FROM folders ORDER BY modified DESC').filter(f=>permits(s,f.id));const ids=new Set(fs.map(f=>f.id));const sharing=s.account==='super'||fs.some(f=>permits(s,f.id,'manage'));return {user:publicUser(s),csrf:s.csrf,limits:{maxFileBytes:maxFile,quotaBytes:quota},folders:fs.map(f=>({...f,permission:permission(s,f.id),grants:Object.fromEntries(all('SELECT user_id,role FROM grants WHERE folder_id=?',rootFolder(f.id).id).map(g=>[g.user_id,g.role]))})),files:[...all("SELECT id,name,folder,size,mime,owner,modified,'host' source,NULL path,0 reference FROM files"),...all("SELECT id,name,folder,0 size,'' mime,owner,modified,source,path,1 reference FROM file_references")].sort((a,b)=>b.modified-a.modified).filter(f=>ids.has(f.folder)).map(f=>({...f,ext:f.name.includes('.')?f.name.split('.').pop().toLowerCase():'',date:new Date(f.modified).toISOString().slice(0,10),url:f.reference?null:`/api/files/${f.id}/content?inline=1`})),users:all('SELECT id,name,email,account,active,must_change FROM users ORDER BY name').filter(u=>s.account==='super'||u.active).map(u=>{const safe=publicUser(u);if(!sharing&&u.id!==s.user_id)delete safe.email;return safe;})};}
  const sync=createSyncApi({db,get,all,run,transaction,ensure,json,body,name,audit,dataDir,maxFile,quota,permits,permission,requireFolder,requireFile,detectMime,
    acquireUpload:id=>{ensure(uploads<2&&!uploaders.has(id),429,'Another upload is in progress. Try again shortly.');uploads++;uploaders.add(id);},
    releaseUpload:id=>{uploads--;uploaders.delete(id);}});
  const updates=createUpdatesApi({db,get,all,run,transaction,ensure,json,body,session,audit,requireFile:(s,id)=>{const ref=get('SELECT *,1 reference FROM file_references WHERE id=?',id);if(ref){requireFolder(s,ref.folder);return ref;}return requireFile(s,id);},permits});
  const groups=createGroupsApi({db,get,all,run,transaction,ensure,json,body,session,audit});
  const calendar=createCalendarApi({db,get,all,run,transaction,ensure,json,body,session,audit});
  const server=http.createServer(async(req,res)=>{
    res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Referrer-Policy','no-referrer');res.setHeader('Cache-Control','no-store');
    res.setHeader('X-Frame-Options','SAMEORIGIN');res.setHeader('Cross-Origin-Resource-Policy','same-origin');res.setHeader('Cross-Origin-Opener-Policy','same-origin');res.setHeader('X-DNS-Prefetch-Control','off');res.setHeader('X-Permitted-Cross-Domain-Policies','none');
    res.setHeader('Permissions-Policy','camera=(), microphone=(), geolocation=()');
    res.setHeader('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' blob: data:; frame-src 'self'; object-src 'none'; connect-src 'self'; worker-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'");
    if(production)res.setHeader('Strict-Transport-Security','max-age=31536000');
    try{
      const url=new URL(req.url,'http://localhost');const route=url.pathname;const method=req.method;requestGuard(req,res,url);
      if(route==='/api/health'&&method==='GET')return json(res,200,{ok:true,service:'occ-cloud',schema:2,calendar:true,hardening:1,workspace:2,locations:1,updates:1});
      if(route==='/api/status'&&method==='GET')return json(res,200,{setupRequired:setupRequired()});
      if(route==='/api/setup'&&method==='POST'){
        checkOrigin(req);ensure(setupRequired(),409,'The first account has already been created.');const key=rateKey(req);checkRate(key);const data=await body(req);const expected=get("SELECT value FROM settings WHERE key='setup_hash'")?.value;const received=hash(String(data.token||''));if(!expected||!timingSafeEqual(Buffer.from(expected),Buffer.from(received))){failedAttempt(key);fail(403,'The setup key is incorrect.');}
        ensure(authWork<4,429,'Please retry in a moment.');authWork++;let pw;try{pw=await passwordHash(data.password)}finally{authWork--}const id=randomUUID(),n=text(data.name,80),e=email(data.email);
        transaction(()=>{ensure(setupRequired(),409,'The first account has already been created.');run('INSERT INTO users VALUES(?,?,?,?,?,?,?,?)',id,n,e,'super',1,pw,0,now());run("DELETE FROM settings WHERE key='setup_hash'");audit(id,'workspace.setup',id);});try{unlinkSync(join(dataDir,'setup-token'))}catch{}return json(res,201,{ok:true});
      }
      if(route==='/api/login'&&method==='POST'){
        checkOrigin(req);const data=await body(req);const e=email(data.email);const key=rateKey(req,e),ipKey=rateKey(req),accountKey=hash('account:'+e);checkRate(key);checkRate(ipKey);checkRate(accountKey);ensure(authWork<4,429,'Please retry in a moment.');authWork++;let valid=false,upgraded;let u;try{u=get('SELECT * FROM users WHERE email=?',e);if(u){valid=await passwordMatches(data.password,u.password_hash);if(valid&&u.active&&u.password_hash.startsWith('scrypt:'))upgraded=await passwordHash(data.password,12);}else await derive(String(data.password||'').slice(0,128),dummySalt,64,strongScrypt);}finally{authWork--}
        if(!u?.active||!valid){failedAttempt(key);failedAttempt(ipKey);failedAttempt(accountKey);audit(null,'login.failed',null,{email:e});fail(401,'Email or password is incorrect, or your account is inactive.');}
        // Re-read after asynchronous password verification to honour revocation/reset.
        const fresh=get('SELECT * FROM users WHERE id=?',u.id);ensure(fresh?.active&&fresh.password_hash===u.password_hash,401,'Please sign in again.');u=fresh;if(upgraded)run('UPDATE users SET password_hash=? WHERE id=?',upgraded,u.id);run('DELETE FROM failures WHERE key=?',accountKey);
        run('DELETE FROM failures WHERE key=?',key);run('DELETE FROM sessions WHERE created<? OR last_seen<?',now()-43200000,now()-1800000);run('DELETE FROM sessions WHERE token_hash IN (SELECT token_hash FROM sessions WHERE user_id=? ORDER BY created DESC LIMIT -1 OFFSET 9)',u.id);const token=random(),csrf=random();run('INSERT INTO sessions VALUES(?,?,?,?,?)',hash(token),u.id,csrf,now(),now());audit(u.id,'login.success',u.id);return json(res,200,{user:publicUser(u),csrf},{'Set-Cookie':cookie(token)});
      }
      if(await sync.handle(req,res,url))return;
      if(route.startsWith('/api/')){
        const s=session(req);ensure(s,401,'Please sign in to continue.','SIGN_IN_REQUIRED');
        req.occAuthenticated=true;req.occSession=s;if(!['GET','HEAD'].includes(method)){checkOrigin(req);ensure(req.headers['x-csrf-token']===s.csrf,403,'Refresh the page and try again.');}
        if(route==='/api/logout'&&method==='POST'){run('DELETE FROM sessions WHERE token_hash=?',s.token_hash);return json(res,200,{ok:true},{'Set-Cookie':cookie('')});}
        if(route==='/api/me'&&method==='GET')return json(res,200,{user:publicUser(s),csrf:s.csrf});
        if(route==='/api/password'&&method==='POST'){
          const data=await body(req);const passwordKey=hash('password:'+s.user_id);checkRate(passwordKey);const u=get('SELECT * FROM users WHERE id=?',s.user_id);if(!await passwordMatches(data.currentPassword,u.password_hash)){failedAttempt(passwordKey);fail(400,'Your current password is incorrect.');}run('DELETE FROM failures WHERE key=?',passwordKey);ensure(data.password!==data.currentPassword,400,'Choose a different password.');const pw=await passwordHash(data.password);ensure(session(req),401,'Your session ended. Sign in again.');transaction(()=>{ensure(get('SELECT password_hash FROM users WHERE id=?',u.id)?.password_hash===u.password_hash,409,'Your password changed. Sign in again.');run('UPDATE users SET password_hash=?,must_change=0 WHERE id=?',pw,u.id);run('DELETE FROM sessions WHERE user_id=?',u.id);run('UPDATE devices SET revoked=1 WHERE user_id=?',u.id);audit(u.id,'password.changed',u.id);});return json(res,200,{ok:true},{'Set-Cookie':cookie('')});
        }
        ensure(!s.must_change,403,'Change your temporary password to continue.','PASSWORD_CHANGE_REQUIRED');
        if(await updates(req,res,url,s))return;
        if(await groups(req,res,url,s))return;
        if(await calendar(req,res,url,s))return;
        if(await sync.account(req,res,url,s))return;
        if(route==='/api/workspace'&&method==='GET')return json(res,200,workspace(s));
        if(route==='/api/folders'&&method==='POST'){
          const data=await body(req),n=name(data.name),parent=data.parent||null;if(parent)requireFolder(s,parent,'upload');else requireSuper(s);const id=randomUUID();transaction(()=>{run('INSERT INTO folders VALUES(?,?,?,?,?)',id,n,parent,s.user_id,now());audit(s.user_id,'folder.created',id,{name:n,parent})});return json(res,201,{id});
        }
        let match=route.match(/^\/api\/folders\/([a-f0-9-]+)(?:\/(grants))?$/);
        if(match){const [,id,operation]=match;let f=requireFolder(s,id,'manage');if(operation==='grants'&&method==='PUT'){ensure(f.parent===null,400,'Change access on the top-level parent folder.');const data=await body(req);f=requireFolder(s,id,'manage');ensure(f.parent===null,400,'Change access on the top-level parent folder.');const grants=validateGrants(data.grants);transaction(()=>{replaceGrants(id,grants);audit(s.user_id,'folder.access_changed',id,{grants})});return json(res,200,{ok:true});}
          if(!operation&&method==='PATCH'){const data=await body(req);f=requireFolder(s,id,'manage');const n=data.name===undefined?f.name:name(data.name);const parent=data.parent===undefined?f.parent:data.parent||null;if(parent!==f.parent){if(parent)requireFolder(s,parent,'upload');else requireSuper(s);ensure(!subtree(id).includes(parent),400,'A folder cannot be moved inside itself.');}transaction(()=>{run('UPDATE folders SET name=?,parent=?,modified=? WHERE id=?',n,parent,now(),id);if(parent!==f.parent)run('DELETE FROM grants WHERE folder_id=?',id);audit(s.user_id,'folder.updated',id,{name:n,parent})});return json(res,200,{ok:true});}
          if(!operation&&method==='DELETE'){const ids=subtree(id);const doomed=all('SELECT storage_key,folder FROM files').filter(x=>ids.includes(x.folder));transaction(()=>{run('DELETE FROM folders WHERE id=?',id);audit(s.user_id,'folder.deleted',id,{name:f.name,files:doomed.length})});for(const file of doomed)await unlink(join(dataDir,'blobs',file.storage_key)).catch(()=>{});return json(res,200,{ok:true});}
        }
        const referenceMatch=route.match(/^\/api\/references(?:\/([a-f0-9-]{36}))?$/);
        if(referenceMatch&&['POST','PUT','DELETE'].includes(method)){
          const data=await body(req),id=referenceMatch[1];
          ensure((method==='POST'&&!id)||(id&&method!=='POST'),404,'Reference operation not found.');
          const old=id?get('SELECT * FROM file_references WHERE id=?',id):null;
          if(id){ensure(old,404,'Reference not found.');requireFolder(s,old.folder,'manage');ensure(data.modified===old.modified,409,'This reference changed. Refresh before editing.');}
          if(method==='DELETE'){run('DELETE FROM file_references WHERE id=?',id);audit(s.user_id,'reference.deleted',id);return json(res,200,{ok:true});}
          const folder=data.folder,n=name(data.name);requireFolder(s,folder,old?'manage':'upload');
          ensure(['occ','existing'].includes(data.source),400,'Choose OCC Sync or Existing file.');
          ensure(typeof data.path==='string'&&data.path.length<=2048&&!/[\x00-\x1f\x7f]/.test(data.path),400,'Enter a valid drive path.');
          const path=data.path.trim();
          ensure(/^(?:[A-Za-z]:[\\/]|\\\\[^\\/]+[\\/][^\\/]+|\/[^\/])/.test(path),400,'Enter an absolute local, mapped-drive or network-share path.');
          const key=id||randomUUID(),modified=Math.max(now(),(old?.modified||0)+1);
          transaction(()=>{ensure(!get('SELECT id FROM files WHERE folder=? AND LOWER(name)=LOWER(?)',folder,n)&&!get('SELECT id FROM file_references WHERE folder=? AND LOWER(name)=LOWER(?) AND id<>?',folder,n,key),409,'A file or reference with this name already exists here.');
            if(old)run('UPDATE file_references SET name=?,folder=?,source=?,path=?,modified=? WHERE id=?',n,folder,data.source,path,modified,key);
            else run('INSERT INTO file_references VALUES(?,?,?,?,?,?,?)',key,n,folder,data.source,path,s.user_id,modified);
            audit(s.user_id,old?'reference.updated':'reference.created',key,{folder,source:data.source});});
          return json(res,old?200:201,{id:key});
        }
        if(route==='/api/files'&&method==='POST'){
          const folder=url.searchParams.get('folder'),n=name(url.searchParams.get('name'));requireFolder(s,folder,'upload');ensure(!get('SELECT id FROM files WHERE folder=? AND LOWER(name)=LOWER(?)',folder,n)&&!get('SELECT id FROM file_references WHERE folder=? AND LOWER(name)=LOWER(?)',folder,n),409,'A file with this name already exists here.');ensure(uploads<2&&!uploaders.has(s.user_id),429,'Another upload is in progress. Try again shortly.');ensure(Number(req.headers['content-length']||0)<=maxFile,413,'This file exceeds the upload limit.');
          const key=randomUUID(),tmp=join(dataDir,'blobs',key+'.tmp'),destination=join(dataDir,'blobs',key);uploads++;uploaders.add(s.user_id);let size=0,handle,committed=false;
          try{handle=await open(tmp,'wx',0o600);for await(const chunk of req){size+=chunk.length;ensure(size<=maxFile,413,'This file exceeds the upload limit.');for(let offset=0;offset<chunk.length;){const {bytesWritten}=await handle.write(chunk,offset,chunk.length-offset);ensure(bytesWritten>0,500,'Unable to save this file.');offset+=bytesWritten;}}await handle.sync();await handle.close();handle=null;
            const fresh=session(req);ensure(fresh&&!fresh.must_change&&permits(fresh,folder,'upload'),403,'Your access changed during the upload.');const mime=detectMime(tmp);const id=randomUUID();await rename(tmp,destination);const directory=await open(join(dataDir,'blobs'),'r');try{await directory.sync()}finally{await directory.close()}
            transaction(()=>{const current=session(req);ensure(current&&!current.must_change&&permits(current,folder,'upload'),403,'Your access changed during the upload.');ensure((get('SELECT COALESCE(SUM(size),0) total FROM files').total+size)<=quota,413,'Workspace storage is full.');run('INSERT INTO files(id,name,folder,storage_key,size,mime,owner,modified,sha256) VALUES(?,?,?,?,?,?,?,?,?)',id,n,folder,key,size,mime,s.user_id,now(),fileDigest(destination));audit(s.user_id,'file.uploaded',id,{name:n,folder,size});});committed=true;return json(res,201,{id});
          }finally{if(handle)await handle.close().catch(()=>{});if(!committed){await unlink(tmp).catch(()=>{});await unlink(destination).catch(()=>{})}uploads--;uploaders.delete(s.user_id);}
        }
        match=route.match(/^\/api\/files\/([a-f0-9-]+)(?:\/(content))?$/);
        if(match){const [,id,operation]=match;if(operation==='content'&&method==='GET'){const f=requireFile(s,id);const inline=url.searchParams.get('inline')==='1'&&['image/png','image/jpeg','image/gif','image/webp','application/pdf'].includes(f.mime);res.setHeader('Content-Security-Policy',"sandbox; default-src 'none'; frame-ancestors 'self'");res.setHeader('Content-Type',inline?f.mime:'application/octet-stream');res.setHeader('Content-Length',f.size);res.setHeader('Content-Disposition',`${inline?'inline':'attachment'}; filename="download"; filename*=UTF-8''${encodeURIComponent(f.name).replace(/['()*]/g,c=>'%'+c.charCodeAt(0).toString(16))}`);audit(s.user_id,inline?'file.previewed':'file.downloaded',id);const stream=createReadStream(join(dataDir,'blobs',f.storage_key));stream.on('error',()=>{if(!res.headersSent)json(res,404,{error:'Stored file is unavailable.'});else res.destroy()});res.on('close',()=>stream.destroy());stream.pipe(res);return;}
          let f=requireFile(s,id,'manage');if(!operation&&method==='PATCH'){const data=await body(req);f=requireFile(s,id,'manage');const n=data.name===undefined?f.name:name(data.name);const folder=data.folder||f.folder;requireFolder(s,folder,'upload');ensure(!get('SELECT id FROM file_references WHERE folder=? AND LOWER(name)=LOWER(?)',folder,n),409,'A reference with this name already exists here.');transaction(()=>{run('UPDATE files SET name=?,folder=?,modified=?,revision=revision+1 WHERE id=?',n,folder,now(),id);audit(s.user_id,'file.updated',id,{name:n,folder})});return json(res,200,{ok:true});}
          if(!operation&&method==='DELETE'){transaction(()=>{run('DELETE FROM files WHERE id=?',id);audit(s.user_id,'file.deleted',id,{name:f.name})});await unlink(join(dataDir,'blobs',f.storage_key)).catch(()=>{});return json(res,200,{ok:true});}
        }
        if(route==='/api/users'&&method==='POST'){
          requireSuper(s);const data=await body(req);const n=text(data.name,80),e=email(data.email),account=data.account==='super'?'super':'standard';const grants=validUserGrants(data.grants||{});const pw=await passwordHash(data.password);const fresh=session(req);ensure(fresh?.account==='super'&&!fresh.must_change,403,'Your account access changed.');const id=randomUUID();transaction(()=>{run('INSERT INTO users VALUES(?,?,?,?,?,?,?,?)',id,n,e,account,1,pw,1,now());if(account==='standard')for(const [f,r]of Object.entries(grants))run('INSERT INTO grants VALUES(?,?,?)',f,id,r);audit(s.user_id,'user.created',id,{email:e,account})});return json(res,201,{id});
        }
        match=route.match(/^\/api\/users\/([a-f0-9-]+)$/);
        if(match&&method==='PATCH'){
          requireSuper(s);const id=match[1];const u=get('SELECT * FROM users WHERE id=?',id);ensure(u,404,'User not found.');const data=await body(req);const n=data.name===undefined?u.name:text(data.name,80),e=data.email===undefined?u.email:email(data.email),account=data.account===undefined?u.account:data.account;
          ensure(['super','standard'].includes(account),400,'Invalid account type.');const active=data.active===undefined?!!u.active:data.active;ensure(typeof active==='boolean',400,'Invalid account status.');ensure(id!==s.user_id||(active&&account==='super'),400,'You cannot deactivate or demote the account you are using.');const grants=data.grants===undefined?null:validUserGrants(data.grants);const pw=data.password?await passwordHash(data.password):null;
          const fresh=session(req);ensure(fresh?.account==='super'&&!fresh.must_change,403,'Your account access changed.');transaction(()=>{if(u.account==='super'&&(!active||account!=='super'))ensure(get("SELECT COUNT(*) total FROM users WHERE account='super' AND active=1 AND id<>?",id).total>0,400,'Keep at least one active Super User.');run('UPDATE users SET name=?,email=?,account=?,active=? WHERE id=?',n,e,account,Number(active),id);if(pw)run('UPDATE users SET password_hash=?,must_change=1 WHERE id=?',pw,id);if(grants||account==='super'){run('DELETE FROM grants WHERE user_id=?',id);if(account==='standard')for(const [f,r]of Object.entries(grants))run('INSERT INTO grants VALUES(?,?,?)',f,id,r);}if(!active||pw||u.account!==account){run('DELETE FROM sessions WHERE user_id=?',id);run('UPDATE devices SET revoked=1 WHERE user_id=?',id);}audit(s.user_id,'user.updated',id,{email:e,account,active,passwordReset:!!pw})});return json(res,200,{ok:true});
        }
        fail(404,'This operation is unavailable.');
      }
      ensure(method==='GET'||method==='HEAD',405,'Method not allowed.');
      const assets={'/':['index.html','text/html; charset=utf-8'],'/index.html':['index.html','text/html; charset=utf-8'],'/app.js':['app.js','text/javascript; charset=utf-8'],'/styles.css':['styles.css','text/css; charset=utf-8'],'/favicon.svg':['favicon.svg','image/svg+xml'],'/oxygen-care-logo.jpg':['oxygen-care-logo.jpg','image/jpeg']};const asset=assets[route];ensure(asset,404,'Page not found.');const content=readFileSync(join(rootDir,'public',asset[0]));res.writeHead(200,{'Content-Type':asset[1]});res.end(method==='HEAD'?undefined:content);
    }catch(error){if(res.destroyed)return;if(res.headersSent){res.destroy();return}const duplicate=error.code==='ERR_SQLITE_ERROR'&&/UNIQUE constraint/.test(error.message);const foreignKey=/FOREIGN KEY constraint/.test(error.message);const status=error.status||(duplicate?409:foreignKey?409:500);if(status===500)console.error('OCC request failed:',error.message);json(res,status,{error:duplicate?'An item with this name or email already exists.':foreignKey?'The item changed. Refresh and try again.':status===500?'The request could not be completed.':error.message,...(error.code&&error.status?{code:error.code}:{})});}
  });
  server.maxHeadersCount=100;server.maxRequestsPerSocket=1000;server.setTimeout(60000);
  server.requestTimeout=300000;server.headersTimeout=30000;server.keepAliveTimeout=5000;
  server.on('close',()=>db.close());
  return {server,dataDir,db};
}
function detectMime(path){const fd=openSync(path,'r'),b=Buffer.alloc(16);try{readSync(fd,b,0,16,0)}finally{closeSync(fd)}if(b.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])))return 'image/png';if(b[0]===255&&b[1]===216&&b[2]===255)return 'image/jpeg';if(b.subarray(0,3).toString()==='GIF')return 'image/gif';if(b.subarray(0,4).toString()==='RIFF'&&b.subarray(8,12).toString()==='WEBP')return 'image/webp';if(b.subarray(0,5).toString()==='%PDF-')return 'application/pdf';return 'application/octet-stream';}
if(process.argv[1]&&realpathSync(process.argv[1])===fileURLToPath(import.meta.url)){
  const app=createApp();const port=Number(process.env.PORT||3003),host=process.env.HOST||'127.0.0.1';
  app.server.listen(port,host,()=>{console.log(`OCC listening on http://${host}:${port}`);if(existsSync(join(app.dataDir,'setup-token')))console.log('First-run setup required. The setup key is in the protected data directory.');});
  for(const signal of ['SIGINT','SIGTERM'])process.on(signal,()=>app.server.close(()=>process.exit(0)));
}
