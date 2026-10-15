import { writeAudit } from '../../../lib/audit';
import { requireUser } from '../../../lib/auth';
import { getDb } from '../../../lib/db';
import { errorResponse, jsonObject } from '../../../lib/http';

export async function GET() {
  const auth = await requireUser();
  if (auth.response) return auth.response;
  const user = auth.user!;
  const result = await getDb().query(
    `SELECT f.id,f.name,f.source_key AS "sourceKey",f.kind,f.position,
            CASE WHEN $2 THEN true ELSE COALESCE(a.can_read,false) END AS "canRead",
            CASE WHEN $2 THEN true ELSE COALESCE(a.can_write,false) END AS "canWrite"
       FROM custom_fields f
       LEFT JOIN user_field_access a ON a.field_id=f.id AND a.user_id=$1
      WHERE f.active=true AND ($2 OR COALESCE(a.can_read,false) OR COALESCE(a.can_write,false))
      ORDER BY f.position,f.name`,
    [user.id, user.role === 'super_user']
  );
  return Response.json({ fields: result.rows });
}

const uuid = (value: string) => /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(value);
const nameKey = (value: string) => value.toLowerCase().replace(/[\s_/-]+/g, '');
async function saveField(request: Request, editing: boolean) {
  const auth = await requireUser(['super_user']);
  if (auth.response) return auth.response;
  try {
    const body = await jsonObject(request),
      name = String(body.name || '')
        .trim()
        .replace(/\s+/g, ' '),
      kind = String(body.kind || 'text'),
      id = String(body.id || '');
    if (
      !name ||
      name.length > 80 ||
      !['text', 'checkbox', 'comments'].includes(kind) ||
      (editing && !uuid(id))
    )
      throw Error('Enter a field name (up to 80 characters) and valid field type.');
    const db = await getDb().connect();
    try {
      await db.query('BEGIN');
      // Serialize name changes and restores so normalised duplicate labels cannot race.
      await db.query('LOCK TABLE custom_fields IN SHARE ROW EXCLUSIVE MODE');
      const match = await db.query(
        `SELECT id,active FROM custom_fields WHERE translate(lower(name),' _/-','')=$1`,
        [nameKey(name)]
      );
      const duplicate = match.rows.find(
        (row: { id: string; active: boolean }) => !editing || row.id !== id
      );
      if (duplicate && (editing || duplicate.active))
        throw Error('That field name already exists. Choose another name.');
      let result;
      if (editing) {
        result = await db.query(
          "UPDATE custom_fields SET name=$2,kind=CASE WHEN source_key='Serviced' THEN 'text'::field_kind ELSE $3::field_kind END WHERE id=$1 AND active=true RETURNING id,source_key",
          [id, name, kind]
        );
      } else if (duplicate) {
        result = await db.query(
          'UPDATE custom_fields SET name=$2,kind=$3,active=true WHERE id=$1 RETURNING id,source_key',
          [duplicate.id, name, kind]
        );
      } else {
        result = await db.query(
          `INSERT INTO custom_fields(name,kind,position,created_by) VALUES($1,$2,COALESCE((SELECT max(position)+1 FROM custom_fields),0),$3) RETURNING id,source_key`,
          [name, kind, auth.user!.id]
        );
      }
      if (!result.rowCount) throw Error('Report field not found.');
      if (kind === 'checkbox') {
        await db.query(
          `UPDATE report_rows SET values=jsonb_set(values,ARRAY[$1],to_jsonb('No'::text),true) WHERE NOT values ? $1`,
          [result.rows[0].source_key]
        );
      }
      await writeAudit(
        db,
        auth.user!.id,
        editing ? 'updated' : 'created',
        'custom_field',
        result.rows[0].id,
        { name, kind, restored: Boolean(!editing && duplicate) }
      );
      await db.query('COMMIT');
      return Response.json(editing ? { ok: true } : { id: result.rows[0].id }, {
        status: editing ? 200 : 201
      });
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
export async function POST(request: Request) {
  return saveField(request, false);
}
export async function PATCH(request: Request) {
  return saveField(request, true);
}
export async function DELETE(request: Request) {
  const auth = await requireUser(['super_user']);
  if (auth.response) return auth.response;
  try {
    const body = await jsonObject(request),
      name = String(body.name || '').trim();
    if (!name) throw Error('Choose a field to remove.');
    const db = await getDb().connect();
    try {
      await db.query('BEGIN');
      const result = await db.query(
        'UPDATE custom_fields SET active=false WHERE name=$1 AND active=true RETURNING id',
        [name]
      );
      if (!result.rowCount) throw Error('Report field not found.');
      await writeAudit(db, auth.user!.id, 'deleted', 'custom_field', result.rows[0].id, {
        name,
        dataRetained: true
      });
      await db.query('COMMIT');
      return Response.json({ ok: true });
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
