import bcrypt from 'bcryptjs';
import { writeAudit } from '../../../lib/audit';
import { requireUser } from '../../../lib/auth';
import { getDb } from '../../../lib/db';
import { errorResponse, jsonObject } from '../../../lib/http';

const roles = ['super_user', 'department_head', 'department_user', 'engineer', 'warehouse_user'];

export async function GET() {
  const auth = await requireUser(['super_user']);
  if (auth.response) return auth.response;
  const result = await getDb().query(
    `SELECT u.id, u.email::text, u.display_name AS "displayName", u.role, u.department_id AS "departmentId",
            d.name AS "departmentName", u.can_export AS "canExport", u.active,
            COALESCE(jsonb_object_agg(f.id, jsonb_build_object('read', a.can_read, 'write', a.can_write)) FILTER (WHERE f.id IS NOT NULL), '{}'::jsonb) AS permissions
       FROM users u LEFT JOIN departments d ON d.id = u.department_id
       LEFT JOIN user_field_access a ON a.user_id = u.id LEFT JOIN custom_fields f ON f.id = a.field_id
      WHERE u.role::text <> 'customer'
      GROUP BY u.id, d.name ORDER BY u.display_name`
  );
  return Response.json({ users: result.rows });
}

export async function POST(request: Request) {
  const auth = await requireUser(['super_user']);
  if (auth.response) return auth.response;
  try {
    const body = await jsonObject(request);
    const email = String(body.email || '')
      .trim()
      .toLowerCase();
    const displayName = String(body.displayName || '').trim();
    const password = String(body.password || '');
    const role = String(body.role || 'department_user');
    const departmentName = String(body.departmentName || '').trim();
    if (
      !email ||
      email.length > 254 ||
      !displayName ||
      password.length < 12 ||
      Buffer.byteLength(password, 'utf8') > 72 ||
      !roles.includes(role)
    )
      throw new Error(
        'Name, valid role, email, and a password of at least 12 characters (maximum 72 UTF-8 bytes) are required.'
      );
    const db = getDb(),
      client = await db.connect();
    try {
      await client.query('BEGIN');
      let departmentId: string | null = null;
      if (departmentName) {
        const department = await client.query(
          'INSERT INTO departments (name) VALUES ($1) ON CONFLICT (name) DO UPDATE SET name = EXCLUDED.name RETURNING id',
          [departmentName]
        );
        departmentId = department.rows[0].id;
      }
      const created = await client.query(
        `INSERT INTO users (email, display_name, role, department_id, password_hash, can_export)
         VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
        [
          email,
          displayName,
          role,
          departmentId,
          await bcrypt.hash(password, 12),
          Boolean(body.canExport)
        ]
      );
      await writeAudit(client, auth.user!.id, 'created', 'user', created.rows[0].id, {
        email,
        role
      });
      await client.query('COMMIT');
      return Response.json({ id: created.rows[0].id }, { status: 201 });
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
