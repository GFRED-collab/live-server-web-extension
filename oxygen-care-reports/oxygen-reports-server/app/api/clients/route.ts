import { writeAudit } from '../../../lib/audit';
import { requireUser } from '../../../lib/auth';
import { getDb } from '../../../lib/db';
import { errorResponse, jsonObject } from '../../../lib/http';
import { validateClientName } from '../../../lib/client-name';

export async function GET() {
  const auth = await requireUser();
  if (auth.response) return auth.response;
  const result = await getDb().query(
    `SELECT id,name,contact_name AS "contactName",email,phone,address,notes FROM clients ORDER BY name`
  );
  return Response.json({ clients: result.rows });
}

export async function POST(request: Request) {
  const auth = await requireUser(['super_user']);
  if (auth.response) return auth.response;
  try {
    const body = await jsonObject(request),
      name = validateClientName(body.name);
    const db = getDb();
    const result = await db.query(
      `INSERT INTO clients(name,contact_name,email,phone,address,notes,created_by) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
      [
        name,
        String(body.contactName || '').trim(),
        String(body.email || '').trim(),
        String(body.phone || '').trim(),
        String(body.address || '').trim(),
        String(body.notes || '').trim(),
        auth.user!.id
      ]
    );
    await writeAudit(db, auth.user!.id, 'created', 'client', result.rows[0].id, { name });
    return Response.json({ id: result.rows[0].id }, { status: 201 });
  } catch (error) {
    return errorResponse(error);
  }
}
