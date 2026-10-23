import bcrypt from 'bcryptjs';
import { createHash, randomBytes } from 'node:crypto';
import QRCode from 'qrcode';
import { getDb } from '../../../../lib/db';
import { errorResponse, jsonObject } from '../../../../lib/http';
import { createSession } from '../../../../lib/auth';
import { writeAudit } from '../../../../lib/audit';
import { startSecondStep, twoStepEnabled } from '../../../../lib/sign-in';

const failures = new Map<string, number[]>();
const failureWindowMs = 15 * 60 * 1000;
const failureLimit = 8;
const maximumTrackedAccounts = 10000;
// Unknown accounts incur the same bcrypt work as existing accounts.
const dummyHash = bcrypt.hashSync(randomBytes(32).toString('hex'), 12);

function failureKey(email: string) {
  return createHash('sha256').update(email).digest('hex');
}

function recentFailures(key: string) {
  const cutoff = Date.now() - failureWindowMs;
  const recent = (failures.get(key) || []).filter(time => time > cutoff);
  if (recent.length) failures.set(key, recent);
  else failures.delete(key);
  return recent;
}

export async function POST(request: Request) {
  try {
    const body = await jsonObject(request);
    const email = String(body.email || '')
      .trim()
      .toLowerCase();
    const password = String(body.password || '');
    if (!email || !password || email.length > 254 || Buffer.byteLength(password, 'utf8') > 72)
      return Response.json(
        { error: 'Enter a valid email and password (maximum 72 UTF-8 bytes).' },
        { status: 400 }
      );
    const key = failureKey(email),
      attempts = recentFailures(key);
    for (const tracked of failures.keys()) recentFailures(tracked);
    if (!failures.has(key) && failures.size >= maximumTrackedAccounts)
      return Response.json(
        { error: 'Sign-in is temporarily busy. Try again later.' },
        { status: 429, headers: { 'Retry-After': '900' } }
      );
    if (attempts.length >= failureLimit)
      return Response.json(
        { error: 'Too many sign-in attempts. Wait 15 minutes and try again.' },
        { status: 429, headers: { 'Retry-After': '900' } }
      );
    // Reserve before async work so concurrent requests cannot bypass the limit.
    failures.set(key, [...attempts, Date.now()]);
    const db = getDb();
    const result = await db.query(
      `SELECT id, email::text, role::text, password_hash, mfa_enabled_at IS NOT NULL AS "mfaEnabled"
         FROM users WHERE email = $1 AND active = true`,
      [email]
    );
    const account = result.rows[0];
    const matches = await bcrypt.compare(password, account?.password_hash || dummyHash);
    if (!account || !matches) {
      return Response.json({ error: 'Email or password is incorrect.' }, { status: 401 });
    }
    failures.delete(key);
    await db.query('DELETE FROM sessions WHERE expires_at <= now()');
    if (!twoStepEnabled()) {
      await createSession(account.id);
      await writeAudit(db, account.id, 'signed_in', 'session', null, { secondStep: 'off' });
      return Response.json({ step: 'none' });
    }
    // The password is right; the session starts only after the second step (/api/auth/verify).
    let next;
    try {
      next = await startSecondStep(db, account);
    } catch (error) {
      const known = (error as { status?: number }).status === 503;
      console.error(
        'Sign-in second step failed:',
        (error as { code?: string }).code || (error as Error).message
      );
      return Response.json(
        {
          error: known
            ? (error as Error).message
            : 'Sign-in could not be completed right now. Please try again shortly.'
        },
        { status: 503 }
      );
    }
    if (next.step === 'totp_setup')
      return Response.json({
        ...next,
        qrSvg: await QRCode.toString(next.otpauthUrl, {
          type: 'svg',
          margin: 1,
          errorCorrectionLevel: 'M'
        })
      });
    return Response.json(next);
  } catch (error) {
    return errorResponse(error);
  }
}
