import bcrypt from 'bcryptjs';
import { writeAudit } from '../../../../lib/audit';
import { requireUser } from '../../../../lib/auth';
import { getDb } from '../../../../lib/db';
import { errorResponse, jsonObject } from '../../../../lib/http';

const roles = ['super_user', 'department_head', 'department_user', 'engineer', 'warehouse_user'];
type Context = { params: Promise<{ id: string }> };

export async function PATCH(request: Request, context: Context) {
  const auth = await requireUser(['super_user']);
  if (auth.response) return auth.response;
  try {
    const { id } = await context.params,
      body = await jsonObject(request),
      db = getDb(),
      client = await db.connect();
    const role = String(body.role || '');
    if (!roles.includes(role)) throw new Error('Choose a valid role.');
    const departmentName = String(body.departmentName || '').trim();
    try {
      await client.query('BEGIN');
      let departmentId: string | null = null;
      if (departmentName)
        departmentId = (
          await client.query(
            'INSERT INTO departments (name) VALUES ($1) ON CONFLICT (name) DO UPDATE SET name = EXCLUDED.name RETURNING id',
            [departmentName]
          )
        ).rows[0].id;
      const password = String(body.password || '');
      if (password && (password.length < 12 || Buffer.byteLength(password, 'utf8') > 72))
        throw new Error('Passwords must have at least 12 characters and at most 72 UTF-8 bytes.');
      const updated = await client.query(
        `UPDATE users SET email=$2, display_name=$3, role=$4, department_id=$5, can_export=$6,
          password_hash=CASE WHEN $7::text = '' THEN password_hash ELSE $8 END
         WHERE id=$1 RETURNING id`,
        [
          id,
          String(body.email || '')
            .trim()
            .toLowerCase(),
          String(body.displayName || '').trim(),
          role,
          departmentId,
          Boolean(body.canExport),
          password,
          password ? await bcrypt.hash(password, 12) : ''
        ]
      );
      if (!updated.rowCount) throw new Error('User not found.');
      if (password) await client.query('DELETE FROM sessions WHERE user_id = $1', [id]);
      await writeAudit(client, auth.user!.id, 'updated', 'user', id, { role });
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

export async function DELETE(_: Request, context: Context) {
  const auth = await requireUser(['super_user']);
  if (auth.response) return auth.response;
  try {
    const { id } = await context.params;
    if (id === auth.user!.id) throw new Error('You cannot delete your own account.');
    const db = getDb(),
      client = await db.connect();
    try {
      await client.query('BEGIN');
      const deleted = await client.query('DELETE FROM users WHERE id=$1 RETURNING email::text', [
        id
      ]);
      if (!deleted.rowCount) throw new Error('User not found.');
      await writeAudit(client, auth.user!.id, 'deleted', 'user', id, {
        email: deleted.rows[0].email
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
