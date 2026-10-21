import { getDb } from '../../../../lib/db';
import { errorResponse } from '../../../../lib/http';
import { maskEmail } from '../../../../lib/mfa';
import { challengeToken, clearChallengeCookie, sendEmailCode } from '../../../../lib/sign-in';

const maximumSends = 4;

/** Sends a new email sign-in code (customers), at most once a minute and four times in all. */
export async function POST() {
  try {
    const token = await challengeToken();
    const found = token
      ? await getDb().query(
          `SELECT c.id, c.sends, c.last_sent_at > now()-interval '60 seconds' AS recent, u.email::text
             FROM login_challenges c JOIN users u ON u.id=c.user_id AND u.active=true
            WHERE c.token_hash=$1 AND c.kind='email' AND c.expires_at>now()`,
          [token]
        )
      : null;
    const challenge = found?.rows[0];
    if (!challenge) {
      await clearChallengeCookie();
      return Response.json(
        { error: 'Your sign-in has expired. Enter your password again.', restart: true },
        { status: 401 }
      );
    }
    if (challenge.recent)
      return Response.json(
        { error: 'Please wait a minute before asking for another code.' },
        { status: 429, headers: { 'Retry-After': '60' } }
      );
    if (challenge.sends >= maximumSends)
      return Response.json(
        {
          error: 'No more codes can be sent for this sign-in. Enter your password again.',
          restart: true
        },
        { status: 429 }
      );
    try {
      await sendEmailCode(getDb(), challenge.id, challenge.email);
    } catch (error) {
      console.error(
        'Sign-in code email failed:',
        (error as { code?: string }).code || (error as Error).message
      );
      return Response.json(
        { error: 'The code could not be sent right now. Please try again shortly.' },
        { status: 503 }
      );
    }
    return Response.json({ ok: true, sentTo: maskEmail(challenge.email) });
  } catch (error) {
    return errorResponse(error);
  }
}
