const assert = require('node:assert/strict');
const { loadTs } = require('./test-load-ts.cjs');
const mfa = loadTs('lib/mfa.ts');

// RFC 6238 appendix B test vectors (SHA-1, 8 digits) for the shared secret "12345678901234567890".
const secret = Buffer.from('12345678901234567890');
for (const [time, code] of [
  [59, '94287082'],
  [1111111109, '07081804'],
  [1111111111, '14050471'],
  [1234567890, '89005924'],
  [2000000000, '69279037'],
  [20000000000, '65353130']
])
  assert.equal(mfa.totpCode(secret, Math.floor(time / 30), 8), code, `RFC 6238 at ${time}`);
assert.equal(mfa.totpCode(secret, 1), '287082');

// Base32 (RFC 4648) used by authenticator apps.
assert.equal(mfa.base32Encode(secret), 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ');
assert.deepEqual(mfa.base32Decode('gezd gnbv-gy3tqojqgezdgnbvgy3tqojq'), secret);
const random = mfa.newTotpSecret();
assert.equal(random.length, 20);
assert.deepEqual(mfa.base32Decode(mfa.base32Encode(random)), random);

// Codes from one step either side are accepted; reused or older steps are not.
const now = 1_700_000_000_000,
  step = mfa.currentStep(now);
assert.equal(mfa.verifyTotp(random, mfa.totpCode(random, step), null, now), step);
assert.equal(mfa.verifyTotp(random, mfa.totpCode(random, step - 1), null, now), step - 1);
assert.equal(mfa.verifyTotp(random, mfa.totpCode(random, step + 1), null, now), step + 1);
assert.equal(mfa.verifyTotp(random, mfa.totpCode(random, step - 2), null, now), null);
assert.equal(mfa.verifyTotp(random, mfa.totpCode(random, step), step, now), null);
assert.equal(mfa.verifyTotp(random, 'abcdef', null, now), null);
assert.equal(mfa.verifyTotp(random, '1234567', null, now), null);

const url = new URL(mfa.otpauthUrl('anne@example.com', secret));
assert.equal(url.protocol, 'otpauth:');
assert.equal(url.searchParams.get('secret'), 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ');
assert.equal(url.searchParams.get('issuer'), 'Irish Hospital Supplies Reports');
assert.equal(mfa.groupedKey(secret), 'GEZD GNBV GY3T QOJQ GEZD GNBV GY3T QOJQ');

// Authenticator keys are encrypted at rest; tampering or a missing key fails closed.
const previousKey = process.env.MFA_ENCRYPTION_KEY;
delete process.env.MFA_ENCRYPTION_KEY;
assert.throws(() => mfa.encryptSecret(random), /not configured/);
process.env.MFA_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64');
const stored = mfa.encryptSecret(random);
assert.notDeepEqual(stored.subarray(28), random);
assert.deepEqual(mfa.decryptSecret(stored), random);
const tampered = Buffer.from(stored);
tampered[tampered.length - 1] ^= 1;
assert.throws(() => mfa.decryptSecret(tampered));
process.env.MFA_ENCRYPTION_KEY = Buffer.alloc(32, 8).toString('base64');
assert.throws(() => mfa.decryptSecret(stored), 'a different key cannot read it');
if (previousKey === undefined) delete process.env.MFA_ENCRYPTION_KEY;
else process.env.MFA_ENCRYPTION_KEY = previousKey;

// Recovery codes: ten distinct XXXX-XXXX codes; typing variations match the stored hash.
const codes = mfa.newRecoveryCodes();
assert.equal(codes.length, 10);
assert.equal(new Set(codes).size, 10);
for (const code of codes) assert.match(code, /^[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/);
assert.equal(
  mfa.recoveryHash(codes[0]),
  mfa.recoveryHash(` ${codes[0].toLowerCase().replace('-', ' ')} `)
);
assert.notEqual(mfa.recoveryHash(codes[0]), mfa.recoveryHash(codes[1]));

// Email codes and the masked address shown on screen.
for (let index = 0; index < 50; index++) assert.match(mfa.emailCode(), /^\d{6}$/);
assert.equal(mfa.maskEmail('anne.smith@clinic.ie'), 'a••••••@clinic.ie');
assert.equal(mfa.maskEmail('jo@clinic.ie'), 'j•@clinic.ie');
assert.ok(mfa.sameText('123456', '123456'));
assert.ok(!mfa.sameText('123456', '123457'));
assert.ok(!mfa.sameText('123456', '12345'));

console.log(
  'PASS two-step sign-in: RFC 6238 vectors, drift window and reuse refusal, base32, encrypted keys, recovery and email codes.'
);
