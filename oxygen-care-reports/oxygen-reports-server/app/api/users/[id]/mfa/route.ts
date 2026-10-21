import { writeAudit } from '../../../../../lib/audit';
import { requireUser } from '../../../../../lib/auth';
import { getDb } from '../../../../../lib/db';
import { errorResponse } from '../../../../../lib/http';

type Context = { params: Promise<{ id: string }> };
const uuid = (value: string) => /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(value);

/**
 * A Super User resets a staff member's authenticator (for example a lost phone). The person
 * sets up a new one at their next sign-in; their open sessions end now.
 */
export async function DELETE(_request: Request, context: Context) {
  const auth = await requireUser(['super_user']);
  if (auth.response) return auth.response;
  try {
    const { id } = await context.params;
    if (!uuid(id)) return Response.json({ error: 'User not found.' }, { status: 404 });
    if (id === auth.user!.id)
      return Response.json(
        { error: 'You cannot reset your own authenticator. Ask another Super User.' },
        { status: 400 }
      );
    const client = await getDb().connect();
    try {
      await client.query('BEGIN');
      const result = await client.query(
        `UPDATE users SET mfa_secret_encrypted=NULL, mfa_enabled_at=NULL, mfa_last_step=NULL,
           mfa_recovery_hashes='{}' WHERE id=$1 AND role::text<>'customer' RETURNING id`,
        [id]
      );
      if (!result.rowCount) {
        await client.query('ROLLBACK');
        return Response.json({ error: 'Staff member not found.' }, { status: 404 });
      }
      await client.query('DELETE FROM sessions WHERE user_id=$1', [id]);
      await client.query('DELETE FROM login_challenges WHERE user_id=$1', [id]);
      await writeAudit(client, auth.user!.id, 'updated', 'user', id, { authenticator: 'reset' });
      await client.query('COMMIT');
      return Response.json({ ok: true });
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  } catch (error) {
    return errorResponse(error);
  }
}
