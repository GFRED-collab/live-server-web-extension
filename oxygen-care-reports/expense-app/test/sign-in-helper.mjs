import { createHmac } from 'node:crypto';

// Test servers need the key that encrypts authenticator secrets.
export const mfaTestEnv = { MFA_ENCRYPTION_KEY: Buffer.alloc(32, 9).toString('base64') };

const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
function base32Decode(text) {
  let bits = 0,
    value = 0;
  const output = [];
  for (const character of text.replace(/\s/g, '')) {
    value = (value << 5) | alphabet.indexOf(character);
    bits += 5;
    if (bits >= 8) {
      output.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(output);
}
export function totp(key, step) {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step));
  const hmac = createHmac('sha1', base32Decode(key)).update(counter).digest();
  const offset = hmac[19] & 15;
  return String((hmac.readUInt32BE(offset) & 0x7fffffff) % 1e6).padStart(6, '0');
}

// What a person's phone and notes would hold, per server and email.
const people = new Map();

const cookieFrom = (setCookie, name) => new RegExp(`${name}=([^;,]*)`).exec(setCookie || '')?.[1];

/**
 * Signs in like a person would: password, then the authenticator code (set up on first use).
 * Returns the session cookie string and the raw Set-Cookie header of the final response.
 */
export async function signIn(base, email, password) {
  const login = await fetch(`${base}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password })
  });
  const step = await login.json();
  if (login.status !== 200) return { status: login.status, body: step };
  const challenge = `oc_challenge=${cookieFrom(login.headers.get('set-cookie'), 'oc_challenge')}`;
  const id = `${base}|${email}`;
  if (step.step === 'totp_setup') people.set(id, { key: step.key, lastStep: -1, recovery: [] });
  const person = people.get(id);
  // Use the next unused 30-second step, or a recovery code if all nearby steps are used.
  const now = Math.floor(Date.now() / 30_000);
  const free = [now, now + 1].find(candidate => candidate > person.lastStep);
  const code = free === undefined ? person.recovery.shift() : totp(person.key, free);
  if (free !== undefined) person.lastStep = free;
  const verify = await fetch(`${base}/api/auth/verify`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie: challenge },
    body: JSON.stringify({ code })
  });
  const result = await verify.json();
  if (verify.status !== 200) return { status: verify.status, body: result };
  if (result.recoveryCodes) person.recovery = [...result.recoveryCodes];
  const setCookie = verify.headers.get('set-cookie');
  return {
    status: 200,
    body: result,
    setCookie,
    cookie: `oc_session=${cookieFrom(setCookie, 'oc_session')}; oc_csrf=${cookieFrom(setCookie, 'oc_csrf')}`
  };
}
