import { writeAudit } from '../../../lib/audit';
import { requireUser } from '../../../lib/auth';
import { getDb } from '../../../lib/db';
import { errorResponse, jsonObject } from '../../../lib/http';

export async function GET() {
  const auth = await requireUser();
  if (auth.response) return auth.response;
  const user = auth.user!,
    params: unknown[] = [];
  let access = '';
  if (user.role !== 'super_user') {
    params.push(user.id);
    access =
      'WHERE EXISTS(SELECT 1 FROM contract_assignments ca WHERE ca.contract_id=ct.id AND ca.user_id=$1)';
  }
  const result = await getDb().query(
    `
    SELECT ct.id,ct.contract_number AS "contractNumber",ct.name,ct.status,ct.start_date::text AS "startDate",ct.end_date::text AS "endDate",ct.notes,
           c.id AS "clientId",c.name AS "clientName",c.contact_name AS "contactName",c.email,c.phone,c.address,
           count(DISTINCT cd.device_id)::int AS "deviceCount",count(DISTINCT sv.id)::int AS "visitCount",
           max(sv.service_date)::text AS "lastServiceDate",
           COALESCE(jsonb_agg(DISTINCT ca.user_id) FILTER(WHERE ca.user_id IS NOT NULL),'[]') AS "userIds"
      FROM contracts ct JOIN clients c ON c.id=ct.client_id
      LEFT JOIN contract_devices cd ON cd.contract_id=ct.id AND cd.removed_on IS NULL
      LEFT JOIN service_visits sv ON sv.contract_id=ct.id
      LEFT JOIN contract_assignments ca ON ca.contract_id=ct.id
      ${access}
     GROUP BY ct.id,c.id ORDER BY c.name,ct.name`,
    params
  );
  return Response.json({ contracts: result.rows });
}

export async function POST(request: Request) {
  const auth = await requireUser(['super_user']);
  if (auth.response) return auth.response;
  try {
    const body = await jsonObject(request),
      clientId = String(body.clientId || ''),
      name = String(body.name || '').trim();
    const userIds = Array.isArray(body.userIds) ? body.userIds.map(String) : [];
    if (!clientId || !name) throw new Error('Client and contract name are required.');
    const db = getDb(),
      client = await db.connect();
    try {
      await client.query('BEGIN');
      const created = await client.query(
        `INSERT INTO contracts(client_id,contract_number,name,start_date,end_date,notes,created_by) VALUES($1,$2,$3,$4::date,$5::date,$6,$7) RETURNING id`,
        [
          clientId,
          String(body.contractNumber || '').trim(),
          name,
          String(body.startDate || '') || null,
          String(body.endDate || '') || null,
          String(body.notes || '').trim(),
          auth.user!.id
        ]
      );
      for (const userId of userIds)
        await client.query(
          `INSERT INTO contract_assignments(contract_id,user_id,assigned_by) VALUES($1,$2,$3) ON CONFLICT DO NOTHING`,
          [created.rows[0].id, userId, auth.user!.id]
        );
      await writeAudit(client, auth.user!.id, 'created', 'contract', created.rows[0].id, {
        clientId,
        name,
        userIds
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
