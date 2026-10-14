import bcrypt from 'bcryptjs';
import { requireUser } from '../../../lib/auth';
import { getDb } from '../../../lib/db';
import { writeAudit } from '../../../lib/audit';
import { jsonObject, errorResponse } from '../../../lib/http';
const uuid = (value: string) => /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(value);
export async function GET() {
  const auth = await requireUser(['super_user']);
  if (auth.response) return auth.response;
  try {
    const result = await getDb().query(
      `SELECT u.id,u.display_name AS name,u.email::text,u.client_id AS "clientId",c.name AS "clientName",u.active,u.can_export AS "canExport" FROM users u JOIN clients c ON c.id=u.client_id WHERE u.role='customer' ORDER BY c.name,u.display_name`
    );
    return Response.json({ accounts: result.rows });
  } catch (error) {
    return errorResponse(error);
  }
}
async function save(request: Request, editing: boolean) {
  const auth = await requireUser(['super_user']);
  if (auth.response) return auth.response;
  try {
    const body = await jsonObject(request),
      id = String(body.id || ''),
      name = String(body.name || '').trim(),
      email = String(body.email || '')
        .trim()
        .toLowerCase(),
      clientId = String(body.clientId || ''),
      password = String(body.password || '');
    if (
      !name ||
      name.length > 120 ||
      email.length > 254 ||
      !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ||
      !uuid(clientId) ||
      (editing && !uuid(id))
    )
      throw Error('Enter a name, email and valid client.');
    if (
      (!editing || password) &&
      (password.length < 12 || Buffer.byteLength(password, 'utf8') > 72)
    )
      throw Error('Passwords require at least 12 characters and at most 72 UTF-8 bytes.');
    if (typeof body.canExport !== 'boolean' || typeof body.active !== 'boolean')
      throw Error('Choose valid account access settings.');
    const hash = password ? await bcrypt.hash(password, 12) : '',
      db = await getDb().connect();
    try {
      await db.query('BEGIN');
      const result = editing
        ? await db.query(
            `UPDATE users SET display_name=$2,email=$3,client_id=$4,can_export=$5,active=$6,password_hash=CASE WHEN $7='' THEN password_hash ELSE $7 END WHERE id=$1 AND role='customer' RETURNING id`,
            [id, name, email, clientId, body.canExport, body.active, hash]
          )
        : await db.query(
            `INSERT INTO users(display_name,email,role,client_id,password_hash,can_export,active) VALUES($1,$2,'customer',$3,$4,$5,$6) RETURNING id`,
            [name, email, clientId, hash, body.canExport, body.active]
          );
      if (!result.rowCount) throw Error('Customer account not found.');
      const accountId = result.rows[0].id;
      if (editing) await db.query('DELETE FROM sessions WHERE user_id=$1', [accountId]);
      await writeAudit(db, auth.user!.id, editing ? 'updated' : 'created', 'user', accountId, {
        role: 'customer',
        clientId,
        active: body.active,
        canExport: body.canExport
      });
      await db.query('COMMIT');
      return Response.json({ id: accountId }, { status: editing ? 200 : 201 });
    } catch (error) {
      await db.query('ROLLBACK');
      throw error;
    } finally {
      db.release();
    }
  } catch (error) {
    return errorResponse(error);
  }
}
export const POST = (request: Request) => save(request, false);
export const PATCH = (request: Request) => save(request, true);
