import { createHash, randomBytes } from 'node:crypto';
import { cookies } from 'next/headers';
import type { Pool, PoolClient } from 'pg';
import { emailConfigured, sendSignInCode } from './mailer';
import {
  emailCode,
  encryptSecret,
  groupedKey,
  hashCode,
  maskEmail,
  newTotpSecret,
  otpauthUrl
} from './mfa';

export const CHALLENGE_COOKIE = 'oxygen_reports_challenge';
export const challengeMinutes = 10;
export const maximumCodeAttempts = 5;

const tokenHash = (token: string) => createHash('sha256').update(token).digest('hex');
export const codeHash = (challengeId: string, code: string) => hashCode(`${challengeId}:${code}`);

export type SignInAccount = {
  id: string;
  email: string;
  role: string;
  mfaEnabled: boolean;
};

export type SecondStep =
  | { step: 'totp' }
  | { step: 'totp_setup'; key: string; otpauthUrl: string }
  | { step: 'email'; sentTo: string };

/**
 * TWO_STEP_SIGN_IN=off in the server settings turns the second step off for everyone (a temporary
 * measure until the hosting migration). Saved authenticators are kept for when it is turned back on.
 */
export const twoStepEnabled = () => process.env.TWO_STEP_SIGN_IN !== 'off';

/** Staff need the authenticator app (set up on first use); customers get an email code. */
export async function startSecondStep(
  db: Pool | PoolClient,
  account: SignInAccount
): Promise<SecondStep> {
  const kind = account.role === 'customer' ? 'email' : account.mfaEnabled ? 'totp' : 'totp_setup';
  if (kind === 'email' && !emailConfigured())
    throw Object.assign(
      new Error('Email sign-in codes are not set up yet. Please contact Irish Hospital Supplies.'),
      { status: 503 }
    );
  const token = randomBytes(32).toString('base64url');
  const secret = kind === 'totp_setup' ? newTotpSecret() : null;
  // One outstanding sign-in per person: starting again replaces the previous one.
  await db.query('DELETE FROM login_challenges WHERE user_id=$1 OR expires_at<=now()', [
    account.id
  ]);
  const created = await db.query(
    `INSERT INTO login_challenges(user_id,token_hash,kind,code_hash,pending_secret,expires_at)
     VALUES($1,$2,$3,$4,$5,now()+make_interval(mins=>$6)) RETURNING id`,
    [
      account.id,
      tokenHash(token),
      kind,
      kind === 'email' ? 'pending' : null,
      secret ? encryptSecret(secret) : null,
      challengeMinutes
    ]
  );
  const id = created.rows[0].id as string;
  if (kind === 'email') await sendEmailCode(db, id, account.email);
  (await cookies()).set(CHALLENGE_COOKIE, token, {
    httpOnly: true,
    sameSite: 'strict',
    secure: process.env.NODE_ENV === 'production',
    path: '/',
    maxAge: challengeMinutes * 60
  });
  if (kind === 'email') return { step: 'email', sentTo: maskEmail(account.email) };
  if (kind === 'totp') return { step: 'totp' };
  return {
    step: 'totp_setup',
    key: groupedKey(secret!),
    otpauthUrl: otpauthUrl(account.email, secret!)
  };
}

/** Emails a fresh code; the previous code stops working. */
export async function sendEmailCode(db: Pool | PoolClient, challengeId: string, email: string) {
  const code = emailCode();
  await db.query(
    `UPDATE login_challenges SET code_hash=$2,attempts=0,sends=sends+1,last_sent_at=now(),
       expires_at=now()+make_interval(mins=>$3) WHERE id=$1`,
    [challengeId, codeHash(challengeId, code), challengeMinutes]
  );
  await sendSignInCode(email, code);
}

export async function challengeToken() {
  const token = (await cookies()).get(CHALLENGE_COOKIE)?.value;
  return token && /^[A-Za-z0-9_-]{43}$/.test(token) ? tokenHash(token) : null;
}

export async function clearChallengeCookie() {
  (await cookies()).delete(CHALLENGE_COOKIE);
}

// Wrong codes per person across sign-in attempts, so re-entering the password can't be
// used to get unlimited guesses at the code.
const codeFailures = new Map<string, number[]>();
const codeFailureWindowMs = 15 * 60 * 1000;
export const codeFailureLimit = 10;

export function recentCodeFailures(userId: string) {
  const cutoff = Date.now() - codeFailureWindowMs;
  const recent = (codeFailures.get(userId) || []).filter(time => time > cutoff);
  if (recent.length) codeFailures.set(userId, recent);
  else codeFailures.delete(userId);
  if (codeFailures.size > 10000) codeFailures.clear();
  return recent.length;
}
export function recordCodeFailure(userId: string) {
  codeFailures.set(userId, [...(codeFailures.get(userId) || []), Date.now()]);
}
export function clearCodeFailures(userId: string) {
  codeFailures.delete(userId);
}
