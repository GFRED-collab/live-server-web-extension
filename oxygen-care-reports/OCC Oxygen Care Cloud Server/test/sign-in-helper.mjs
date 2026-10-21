import {createHmac} from 'node:crypto';
const alphabet='ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
function decode(text){let bits=0,value=0;const out=[];for(const ch of text.replace(/\s/g,'')){value=(value<<5)|alphabet.indexOf(ch);bits+=5;if(bits>=8){out.push((value>>>(bits-8))&255);bits-=8;}}return Buffer.from(out);}
export function totp(key,step){const counter=Buffer.alloc(8);counter.writeBigUInt64BE(BigInt(step));const h=createHmac('sha1',decode(key)).update(counter).digest();const o=h[19]&15;return String((h.readUInt32BE(o)&0x7fffffff)%1e6).padStart(6,'0');}
// What each person's phone and saved recovery codes would hold, by email.
const people=new Map();
// After a correct password, enters the authenticator code (setting it up on first use) like a person would.
export async function completeSignIn(base,email,setCookie,body,headers={}){
  if(body.step==='totp_setup')people.set(email,{key:body.key,lastStep:-1,recovery:[]});
  const person=people.get(email),now=Math.floor(Date.now()/30000),free=[now,now+1].find(step=>step>person.lastStep);
  const code=free===undefined?person.recovery.shift():totp(person.key,free);if(free!==undefined)person.lastStep=free;
  const r=await fetch(base+'/api/login/verify',{method:'POST',headers:{...headers,'Content-Type':'application/json',Cookie:setCookie.split(';')[0]},body:JSON.stringify({code})});
  const data=await r.json();if(data.recoveryCodes)person.recovery=[...data.recoveryCodes];
  return {status:r.status,data,cookie:r.headers.get('set-cookie'),headers:r.headers};
}
// The same second step in the browser: after "Sign in", enter the code (and save recovery codes on first use).
export async function browserCode(page,email){
  await page.locator('#code-form').waitFor();
  const setup=await page.locator('.setup-key').count()>0;
  if(setup)people.set(email,{key:await page.locator('.setup-key').textContent(),lastStep:-1,recovery:[]});
  const person=people.get(email);let step;while((step=[0,1].map(x=>Math.floor(Date.now()/30000)+x).find(x=>x>person.lastStep))===undefined)await page.waitForTimeout(1000);
  person.lastStep=step;await page.locator('#code-form [name=code]').fill(totp(person.key,step));await page.locator('#code-form [type=submit]').click();
  if(setup){await page.locator('#codes-saved').waitFor();await page.locator('#codes-saved').check();await page.locator('#codes-continue').click();}
}
