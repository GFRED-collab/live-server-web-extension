import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  randomBytes,
  randomInt,
  timingSafeEqual
} from 'node:crypto';

/**
 * Second sign-in step. Staff use an authenticator app (TOTP, RFC 6238: SHA-1, 30-second
 * steps, 6 digits); customers receive a 6-digit code by email.
 */

const base32Alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
export const ISSUER = 'Oxygen Care Reports';
const stepSeconds = 30;

export function base32Encode(bytes: Buffer) {
  let bits = 0,
    value = 0,
    output = '';
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += base32Alphabet[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) output += base32Alphabet[(value << (5 - bits)) & 31];
  return output;
}

export function base32Decode(text: string) {
  const clean = text.toUpperCase().replace(/[\s=-]/g, '');
  let bits = 0,
    value = 0;
  const output: number[] = [];
  for (const character of clean) {
    const index = base32Alphabet.indexOf(character);
    if (index < 0) throw new Error('Invalid base32 text.');
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      output.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(output);
}

export function newTotpSecret() {
  return randomBytes(20);
}

/** The code for one 30-second step (digits=8 is only used to check the RFC test vectors). */
export function totpCode(secret: Buffer, step: number, digits = 6) {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step));
  const hmac = createHmac('sha1', secret).update(counter).digest();
  const offset = hmac[hmac.length - 1] & 15;
  const number = hmac.readUInt32BE(offset) & 0x7fffffff;
  return String(number % 10 ** digits).padStart(digits, '0');
}

export const currentStep = (now = Date.now()) => Math.floor(now / 1000 / stepSeconds);

/**
 * Accepts the code for the current step or one step either side (clock drift). Returns the
 * matched step, or null. A step at or before `lastStep` is refused so a code can't be reused.
 */
export function verifyTotp(
  secret: Buffer,
  code: string,
  lastStep: number | null = null,
  now = Date.now()
) {
  if (!/^\d{6}$/.test(code)) return null;
  const step = currentStep(now);
  for (const candidate of [step - 1, step, step + 1]) {
    if (lastStep !== null && candidate <= lastStep) continue;
    if (sameText(totpCode(secret, candidate), code)) return candidate;
  }
  return null;
}

export function otpauthUrl(email: string, secret: Buffer) {
  const label = encodeURIComponent(`${ISSUER}:${email}`);
  const query = new URLSearchParams({
    secret: base32Encode(secret),
    issuer: ISSUER,
    algorithm: 'SHA1',
    digits: '6',
    period: String(stepSeconds)
  });
  return `otpauth://totp/${label}?${query}`;
}

/** Shown to people who type the key in by hand: groups of four. */
export const groupedKey = (secret: Buffer) => base32Encode(secret).replace(/(.{4})(?=.)/g, '$1 ');

// Authenticator keys are stored encrypted (AES-256-GCM) under MFA_ENCRYPTION_KEY.
function encryptionKey() {
  const key = Buffer.from(process.env.MFA_ENCRYPTION_KEY || '', 'base64');
  if (key.length !== 32)
    throw new Error('Two-step sign-in is not configured on this server (MFA_ENCRYPTION_KEY).');
  return key;
}

export function encryptSecret(secret: Buffer) {
  const iv = randomBytes(12),
    cipher = createCipheriv('aes-256-gcm', encryptionKey(), iv);
  const body = Buffer.concat([cipher.update(secret), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), body]);
}

export function decryptSecret(stored: Buffer) {
  const decipher = createDecipheriv('aes-256-gcm', encryptionKey(), stored.subarray(0, 12));
  decipher.setAuthTag(stored.subarray(12, 28));
  return Buffer.concat([decipher.update(stored.subarray(28)), decipher.final()]);
}

export const hashCode = (value: string) => createHash('sha256').update(value).digest('hex');

export function sameText(left: string, right: string) {
  const a = Buffer.from(left),
    b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Ten one-time recovery codes like `K7QM-4XPA`; only their hashes are stored. */
export function newRecoveryCodes() {
  const alphabet = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  return Array.from({ length: 10 }, () => {
    const raw = Array.from({ length: 8 }, () => alphabet[randomInt(alphabet.length)]).join('');
    return `${raw.slice(0, 4)}-${raw.slice(4)}`;
  });
}

export const normaliseRecoveryCode = (value: string) =>
  value.toUpperCase().replace(/[^A-Z0-9]/g, '');

export const recoveryHash = (code: string) => hashCode(`recovery:${normaliseRecoveryCode(code)}`);

export const emailCode = () => String(randomInt(0, 1_000_000)).padStart(6, '0');

export function maskEmail(email: string) {
  const [name, domain] = email.split('@');
  if (!domain) return email;
  return `${name.slice(0, 1)}${'•'.repeat(Math.max(1, Math.min(6, name.length - 1)))}@${domain}`;
}
