import {createCipheriv,createDecipheriv,createHash,createHmac,randomBytes,randomInt,timingSafeEqual} from 'node:crypto';
import {existsSync,readFileSync,writeFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import {join} from 'node:path';
// Kazuhiko Arase's MIT-licensed QR generator (qrcode-generator 1.4.4), vendored because OCC has no npm dependencies.
const qrcode=createRequire(import.meta.url)('./qrcode-generator.cjs');

const alphabet='ABCDEFGHIJKLMNOPQRSTUVWXYZ234567',recoveryAlphabet='ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const challengeMs=600000,maximumAttempts=5,failureLimit=10;
export function base32(bytes){let bits=0,value=0,out='';for(const byte of bytes){value=(value<<8)|byte;bits+=8;while(bits>=5){out+=alphabet[(value>>>(bits-5))&31];bits-=5;}}if(bits>0)out+=alphabet[(value<<(5-bits))&31];return out;}
export function totpCode(secret,step){const counter=Buffer.alloc(8);counter.writeBigUInt64BE(BigInt(step));const h=createHmac('sha1',secret).update(counter).digest();const o=h[h.length-1]&15;return String((h.readUInt32BE(o)&0x7fffffff)%1e6).padStart(6,'0');}
const same=(a,b)=>{a=Buffer.from(String(a));b=Buffer.from(String(b));return a.length===b.length&&timingSafeEqual(a,b);};
// The current 30-second step or one either side (clock drift); a step already used is refused.
export function verifyTotp(secret,code,lastStep=null,at=Date.now()){if(!/^\d{6}$/.test(code))return null;const step=Math.floor(at/30000);for(const candidate of [step-1,step,step+1]){if(lastStep!==null&&candidate<=lastStep)continue;if(same(totpCode(secret,candidate),code))return candidate;}return null;}
const normalise=code=>String(code).toUpperCase().replace(/[^A-Z0-9]/g,'');
const recoveryHash=code=>createHash('sha256').update('recovery:'+normalise(code)).digest('hex');
const newRecoveryCodes=()=>Array.from({length:10},()=>{const raw=Array.from({length:8},()=>recoveryAlphabet[randomInt(recoveryAlphabet.length)]).join('');return raw.slice(0,4)+'-'+raw.slice(4);});

export function createSignInApi(c){
  const {db,get,all,run,transaction,ensure,json,body,audit,checkOrigin,startSession,publicUser,dataDir,production}=c;
  const hash=value=>createHash('sha256').update(value).digest('hex');
  transaction(()=>{
    const columns=new Set(all('PRAGMA table_info(users)').map(x=>x.name));
    for(const [column,type] of [['mfa_secret','TEXT'],['mfa_enabled_at','INTEGER'],['mfa_last_step','INTEGER'],['mfa_recovery',"TEXT NOT NULL DEFAULT '[]'"]])if(!columns.has(column))db.exec(`ALTER TABLE users ADD COLUMN ${column} ${type}`);
    db.exec('CREATE TABLE IF NOT EXISTS login_challenges(token_hash TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,kind TEXT NOT NULL,pending_secret TEXT,attempts INTEGER NOT NULL DEFAULT 0,expires INTEGER NOT NULL)');
  });
  // Authenticator keys are encrypted with MFA_ENCRYPTION_KEY. Outside production a key kept in the data folder will do.
  function key(){
    let text=c.mfaKey??process.env.MFA_ENCRYPTION_KEY??'';
    if(!text&&!production){const file=join(dataDir,'mfa-key');if(!existsSync(file))writeFileSync(file,randomBytes(32).toString('base64')+'\n',{mode:0o600});text=readFileSync(file,'utf8').trim();}
    const value=Buffer.from(text,'base64');ensure(value.length===32,503,'Two-step sign-in is not configured on this server.');return value;
  }
  const encrypt=secret=>{const iv=randomBytes(12),cipher=createCipheriv('aes-256-gcm',key(),iv);const data=Buffer.concat([cipher.update(secret),cipher.final()]);return Buffer.concat([iv,cipher.getAuthTag(),data]).toString('base64');};
  const decrypt=stored=>{const raw=Buffer.from(stored,'base64');const d=createDecipheriv('aes-256-gcm',key(),raw.subarray(0,12));d.setAuthTag(raw.subarray(12,28));return Buffer.concat([d.update(raw.subarray(28)),d.final()]);};
  const cookieName=production?'__Host-occ_challenge':'occ_challenge';
  const cookie=value=>`${cookieName}=${value}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${value?challengeMs/1000:0}${production?'; Secure':''}`;
  const cookieValue=req=>(req.headers.cookie||'').split(';').map(x=>x.trim()).find(x=>x.startsWith(cookieName+'='))?.slice(cookieName.length+1);
  const blocked=userId=>{const r=get('SELECT * FROM failures WHERE key=?',hash('code:'+userId));return !!r&&r.count>=failureLimit&&r.until_at>=Date.now();};
  function codeFailed(userId){run('INSERT INTO failures VALUES(?,1,?) ON CONFLICT(key) DO UPDATE SET count=CASE WHEN until_at<? THEN 1 ELSE count+1 END,until_at=excluded.until_at',hash('code:'+userId),Date.now()+900000,Date.now());}

  // After the password: ask for the authenticator code, or set the authenticator up first.
  function begin(res,u){
    key();run('DELETE FROM login_challenges WHERE expires<? OR user_id=?',Date.now(),u.id);
    const token=randomBytes(32).toString('base64url');let result={step:'totp'},pending=null;
    if(!u.mfa_secret){
      const secret=randomBytes(20),text=base32(secret);pending=encrypt(secret);
      const url=`otpauth://totp/${encodeURIComponent('Irish Hospital Supplies Cloud:'+u.email)}?secret=${text}&issuer=${encodeURIComponent('Irish Hospital Supplies Cloud')}&algorithm=SHA1&digits=6&period=30`;
      const qr=qrcode(0,'M');qr.addData(url);qr.make();
      result={step:'totp_setup',key:text.match(/.{1,4}/g).join(' '),otpauthUrl:url,qrSvg:qr.createSvgTag({cellSize:4,margin:4,scalable:true})};
    }
    run('INSERT INTO login_challenges VALUES(?,?,?,?,0,?)',hash(token),u.id,pending?'totp_setup':'totp',pending,Date.now()+challengeMs);
    audit(u.id,'login.password_accepted',u.id);
    return json(res,200,result,{'Set-Cookie':cookie(token)});
  }

  async function handle(req,res,url){
    if(url.pathname!=='/api/login/verify'||req.method!=='POST')return false;
    checkOrigin(req);const data=await body(req);const code=String(data.code||'').trim();ensure(code&&code.length<=20,400,'Enter the code.');
    const restart=(message,status=401,headers={})=>(json(res,status,{error:message,restart:true},{'Set-Cookie':cookie(''),...headers}),true);
    const token=cookieValue(req);
    const found=token&&get('SELECT c.*,u.active,u.mfa_secret,u.mfa_last_step,u.mfa_recovery FROM login_challenges c JOIN users u ON u.id=c.user_id WHERE c.token_hash=? AND c.expires>?',hash(token),Date.now());
    if(!found?.active)return restart('Your sign-in has expired. Enter your password again.');
    if(blocked(found.user_id)){run('DELETE FROM login_challenges WHERE token_hash=?',found.token_hash);return restart('Too many wrong codes. Wait 15 minutes and sign in again.',429,{'Retry-After':'900'});}
    let step=null,recovery=null;
    if(found.kind==='totp_setup')step=verifyTotp(decrypt(found.pending_secret),code);
    else{
      step=verifyTotp(decrypt(found.mfa_secret),code,found.mfa_last_step);
      // A recovery code works once instead of the authenticator code.
      if(step===null&&normalise(code).length===8&&JSON.parse(found.mfa_recovery).includes(recoveryHash(code)))recovery=recoveryHash(code);
    }
    if(step===null&&!recovery){
      codeFailed(found.user_id);audit(found.user_id,'login.code_failed',found.user_id);
      if(found.attempts+1>=maximumAttempts){run('DELETE FROM login_challenges WHERE token_hash=?',found.token_hash);return restart('Too many wrong codes. Enter your password again.');}
      run('UPDATE login_challenges SET attempts=attempts+1 WHERE token_hash=?',found.token_hash);
      return json(res,401,{error:'That code is not right. Use the current code from your authenticator app.'}),true;
    }
    let recoveryCodes,left;
    transaction(()=>{
      if(found.kind==='totp_setup'){recoveryCodes=newRecoveryCodes();run('UPDATE users SET mfa_secret=?,mfa_enabled_at=?,mfa_last_step=?,mfa_recovery=? WHERE id=?',found.pending_secret,Date.now(),step,JSON.stringify(recoveryCodes.map(recoveryHash)),found.user_id);audit(found.user_id,'user.mfa_enrolled',found.user_id);}
      else if(recovery){const remaining=JSON.parse(found.mfa_recovery).filter(h=>h!==recovery);left=remaining.length;run('UPDATE users SET mfa_recovery=? WHERE id=?',JSON.stringify(remaining),found.user_id);}
      else run('UPDATE users SET mfa_last_step=? WHERE id=?',step,found.user_id);
      run('DELETE FROM login_challenges WHERE token_hash=?',found.token_hash);run('DELETE FROM failures WHERE key=?',hash('code:'+found.user_id));
    });
    const u=get('SELECT * FROM users WHERE id=?',found.user_id),session=startSession(u,recovery?{recoveryCode:true}:{});
    return json(res,200,{user:publicUser(u),csrf:session.csrf,...(recoveryCodes?{recoveryCodes}:{}),...(left!==undefined?{recoveryCodesLeft:left}:{})},{'Set-Cookie':[session.cookie,cookie('')]}),true;
  }

  // A Super User resets someone else's authenticator (lost phone); they set it up again at their next sign-in.
  async function account(req,res,url,s,requireSuper){
    const m=url.pathname.match(/^\/api\/users\/([a-f0-9-]+)\/mfa$/);if(!m||req.method!=='DELETE')return false;
    requireSuper(s);ensure(m[1]!==s.user_id,400,'You cannot reset your own authenticator. Ask another Super User.');ensure(get('SELECT id FROM users WHERE id=?',m[1]),404,'User not found.');
    transaction(()=>{run("UPDATE users SET mfa_secret=NULL,mfa_enabled_at=NULL,mfa_last_step=NULL,mfa_recovery='[]' WHERE id=?",m[1]);run('DELETE FROM sessions WHERE user_id=?',m[1]);run('DELETE FROM login_challenges WHERE user_id=?',m[1]);audit(s.user_id,'user.mfa_reset',m[1]);});
    return json(res,200,{ok:true}),true;
  }
  return {begin,handle,account};
}
