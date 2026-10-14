import { writeAudit } from '../../../../../lib/audit';
import { requireUser } from '../../../../../lib/auth';
import { getDb } from '../../../../../lib/db';
import { errorResponse, jsonObject } from '../../../../../lib/http';
type Context = { params: Promise<{ id: string }> };

export async function PUT(request: Request, context: Context) {
  const auth = await requireUser(['super_user']);
  if (auth.response) return auth.response;
  try {
    const { id } = await context.params,
      body = await jsonObject(request);
    const permissions = Array.isArray(body.permissions) ? body.permissions : [];
    const db = getDb(),
      client = await db.connect();
    try {
      await client.query('BEGIN');
      await client.query('DELETE FROM user_field_access WHERE user_id=$1', [id]);
      await client.query('UPDATE users SET can_export=$2 WHERE id=$1', [
        id,
        Boolean(body.canExport)
      ]);
      for (const item of permissions) {
        if (!item || typeof item !== 'object') continue;
        const value = item as Record<string, unknown>;
        await client.query(
          `INSERT INTO user_field_access (user_id, field_id, can_read, can_write, can_export) VALUES ($1,$2,$3,$4,$5)`,
          [
            id,
            String(value.fieldId),
            Boolean(value.canRead) || Boolean(value.canWrite),
            Boolean(value.canWrite),
            Boolean(value.canExport)
          ]
        );
      }
      await writeAudit(client, auth.user!.id, 'updated', 'user_permissions', id, {
        count: permissions.length
      });
      await client.query('COMMIT');
      return Response.json({ ok: true });
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  } catch (error) {
    return errorResponse(error);
  }
}
