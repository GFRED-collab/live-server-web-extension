import { createSession } from '../../../../lib/auth';
import { writeAudit } from '../../../../lib/audit';
import { getDb } from '../../../../lib/db';
import { errorResponse, jsonObject } from '../../../../lib/http';
import {
  decryptSecret,
  newRecoveryCodes,
  normaliseRecoveryCode,
  recoveryHash,
  sameText,
  verifyTotp
} from '../../../../lib/mfa';
import {
  challengeToken,
  clearChallengeCookie,
  clearCodeFailures,
  codeFailureLimit,
  codeHash,
  maximumCodeAttempts,
  recentCodeFailures,
  recordCodeFailure
} from '../../../../lib/sign-in';

const startAgain = (message: string, status = 401) =>
  Response.json({ error: message, restart: true }, { status });

/** Second sign-in step: checks the code and only then starts the session. */
export async function POST(request: Request) {
  try {
    const body = await jsonObject(request);
    const code = String(body.code || '').trim();
    if (!code || code.length > 20)
      return Response.json({ error: 'Enter the code.' }, { status: 400 });
    const token = await challengeToken();
    if (!token) return startAgain('Your sign-in has expired. Enter your password again.');
    const client = await getDb().connect();
    let outcome: { userId: string; kind: string; recoveryCodes?: string[]; usedRecovery?: boolean };
    try {
      await client.query('BEGIN');
      const found = await client.query(
        `SELECT c.id, c.user_id AS "userId", c.kind, c.code_hash AS "codeHash",
                c.pending_secret AS "pendingSecret", c.attempts,
                u.mfa_secret_encrypted AS "secret", u.mfa_last_step AS "lastStep",
                u.mfa_recovery_hashes AS "recoveryHashes"
           FROM login_challenges c JOIN users u ON u.id=c.user_id AND u.active=true
          WHERE c.token_hash=$1 AND c.expires_at>now() FOR UPDATE OF c, u`,
        [token]
      );
      const challenge = found.rows[0];
      if (!challenge) {
        await client.query('ROLLBACK');
        await clearChallengeCookie();
        return startAgain('Your sign-in has expired. Enter your password again.');
      }
      if (recentCodeFailures(challenge.userId) >= codeFailureLimit) {
        await client.query('DELETE FROM login_challenges WHERE id=$1', [challenge.id]);
        await client.query('COMMIT');
        await clearChallengeCookie();
        return startAgain('Too many wrong codes. Wait 15 minutes and sign in again.', 429);
      }
      let matched = false,
        step: number | null = null,
        usedRecovery = false;
      if (challenge.kind === 'email') {
        matched =
          /^\d{6}$/.test(code) && sameText(challenge.codeHash, codeHash(challenge.id, code));
      } else if (challenge.kind === 'totp_setup') {
        step = verifyTotp(decryptSecret(challenge.pendingSecret), code);
        matched = step !== null;
      } else {
        step = verifyTotp(
          decryptSecret(challenge.secret),
          code,
          challenge.lastStep === null ? null : Number(challenge.lastStep)
        );
        matched = step !== null;
        // A recovery code works once instead of the authenticator code.
        if (!matched && normaliseRecoveryCode(code).length === 8) {
          const hash = recoveryHash(code);
          if ((challenge.recoveryHashes as string[]).includes(hash)) {
            matched = usedRecovery = true;
            await client.query(
              'UPDATE users SET mfa_recovery_hashes=array_remove(mfa_recovery_hashes,$2) WHERE id=$1',
              [challenge.userId, hash]
            );
          }
        }
      }
      if (!matched) {
        recordCodeFailure(challenge.userId);
        const attempts = challenge.attempts + 1;
        if (attempts >= maximumCodeAttempts) {
          await client.query('DELETE FROM login_challenges WHERE id=$1', [challenge.id]);
          await client.query('COMMIT');
          await clearChallengeCookie();
          return startAgain('Too many wrong codes. Enter your password again.');
        }
        await client.query('UPDATE login_challenges SET attempts=$2 WHERE id=$1', [
          challenge.id,
          attempts
        ]);
        await client.query('COMMIT');
        return Response.json(
          {
            error:
              challenge.kind === 'email'
                ? 'That code is not right. Check the latest email and try again.'
                : 'That code is not right. Use the current code from your authenticator app.'
          },
          { status: 401 }
        );
      }
      let recoveryCodes: string[] | undefined;
      if (challenge.kind === 'totp_setup') {
        recoveryCodes = newRecoveryCodes();
        await client.query(
          `UPDATE users SET mfa_secret_encrypted=$2, mfa_enabled_at=now(), mfa_last_step=$3,
             mfa_recovery_hashes=$4 WHERE id=$1`,
          [challenge.userId, challenge.pendingSecret, step, recoveryCodes.map(recoveryHash)]
        );
        await writeAudit(client, challenge.userId, 'updated', 'user', challenge.userId, {
          authenticator: 'set up'
        });
      } else if (step !== null)
        await client.query('UPDATE users SET mfa_last_step=$2 WHERE id=$1', [
          challenge.userId,
          step
        ]);
      await client.query('DELETE FROM login_challenges WHERE id=$1', [challenge.id]);
      await writeAudit(client, challenge.userId, 'signed_in', 'session', null, {
        secondStep: challenge.kind === 'email' ? 'email code' : 'authenticator',
        ...(usedRecovery ? { recoveryCode: true } : {})
      });
      await client.query('COMMIT');
      outcome = { userId: challenge.userId, kind: challenge.kind, recoveryCodes, usedRecovery };
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
    clearCodeFailures(outcome.userId);
    await clearChallengeCookie();
    await createSession(outcome.userId);
    const remaining = outcome.usedRecovery
      ? (
          await getDb().query(
            'SELECT cardinality(mfa_recovery_hashes) AS n FROM users WHERE id=$1',
            [outcome.userId]
          )
        ).rows[0]?.n
      : undefined;
    return Response.json({
      ok: true,
      ...(outcome.recoveryCodes ? { recoveryCodes: outcome.recoveryCodes } : {}),
      ...(remaining !== undefined ? { recoveryCodesLeft: Number(remaining) } : {})
    });
  } catch (error) {
    return errorResponse(error);
  }
}
