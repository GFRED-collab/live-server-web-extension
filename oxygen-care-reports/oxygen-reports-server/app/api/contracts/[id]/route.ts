import { writeAudit } from '../../../../lib/audit';
import { requireUser } from '../../../../lib/auth';
import { getDb } from '../../../../lib/db';
import { errorResponse, jsonObject } from '../../../../lib/http';
type Context = { params: Promise<{ id: string }> };

export async function GET(_: Request, context: Context) {
  const auth = await requireUser();
  if (auth.response) return auth.response;
  const { id } = await context.params,
    user = auth.user!,
    db = getDb();
  if (user.role !== 'super_user') {
    const access = await db.query(
      `SELECT 1 FROM contract_assignments WHERE contract_id=$1 AND user_id=$2`,
      [id, user.id]
    );
    if (!access.rowCount) return Response.json({ error: 'Contract not found.' }, { status: 404 });
  }
  const [contract, devices, visits, users] = await Promise.all([
    db.query(
      `SELECT ct.id,ct.contract_number AS "contractNumber",ct.name,ct.status,ct.start_date::text AS "startDate",ct.end_date::text AS "endDate",ct.notes,c.id AS "clientId",c.name AS "clientName",c.contact_name AS "contactName",c.email,c.phone,c.address,c.notes AS "clientNotes" FROM contracts ct JOIN clients c ON c.id=ct.client_id WHERE ct.id=$1`,
      [id]
    ),
    db.query(
      `SELECT d.id,d.device_name AS "deviceName",d.serial_number AS "serialNumber",d.lot_number AS "lotNumber",d.asset_number AS "assetNumber",d.status,d.purchased_on::text AS "purchasedOn",d.decommissioned_on::text AS "decommissionedOn",d.decommission_reason AS "decommissionReason",d.notes,cd.added_on::text AS "addedOn",cd.removed_on::text AS "removedOn" FROM contract_devices cd JOIN devices d ON d.id=cd.device_id WHERE cd.contract_id=$1 ORDER BY d.status,d.device_name,d.serial_number`,
      [id]
    ),
    db.query(
      `SELECT sv.id,sv.service_date::text AS "serviceDate",sv.title,sv.location,sv.summary,sv.recommendations,sv.status,sv.finalized_at AS "finalizedAt",count(DISTINCT svd.id)::int AS "deviceCount",count(DISTINCT fp.id)::int AS "partCount",count(DISTINCT sig.id)::int AS "signatureCount" FROM service_visits sv LEFT JOIN service_visit_devices svd ON svd.service_visit_id=sv.id LEFT JOIN fitted_parts fp ON fp.service_visit_device_id=svd.id LEFT JOIN service_visit_signatures sig ON sig.service_visit_id=sv.id WHERE sv.contract_id=$1 GROUP BY sv.id ORDER BY sv.service_date DESC`,
      [id]
    ),
    db.query(
      `SELECT u.id,u.display_name AS name,u.email FROM contract_assignments ca JOIN users u ON u.id=ca.user_id WHERE ca.contract_id=$1 ORDER BY u.display_name`,
      [id]
    )
  ]);
  if (!contract.rowCount) return Response.json({ error: 'Contract not found.' }, { status: 404 });
  return Response.json({
    contract: contract.rows[0],
    devices: devices.rows,
    visits: visits.rows,
    assignedUsers: users.rows
  });
}

export async function PATCH(request: Request, context: Context) {
  const auth = await requireUser(['super_user']);
  if (auth.response) return auth.response;
  try {
    const { id } = await context.params,
      body = await jsonObject(request),
      userIds = Array.isArray(body.userIds) ? body.userIds.map(String) : [],
      db = getDb(),
      client = await db.connect();
    try {
      await client.query('BEGIN');
      const updated = await client.query(
        `UPDATE contracts SET contract_number=$2,name=$3,status=$4,start_date=$5::date,end_date=$6::date,notes=$7 WHERE id=$1`,
        [
          id,
          String(body.contractNumber || '').trim(),
          String(body.name || '').trim(),
          String(body.status || 'active'),
          String(body.startDate || '') || null,
          String(body.endDate || '') || null,
          String(body.notes || '').trim()
        ]
      );
      if (!updated.rowCount) throw Error('Contract not found.');
      await client.query(`DELETE FROM contract_assignments WHERE contract_id=$1`, [id]);
      for (const userId of userIds)
        await client.query(
          `INSERT INTO contract_assignments(contract_id,user_id,assigned_by) VALUES($1,$2,$3)`,
          [id, userId, auth.user!.id]
        );
      await writeAudit(client, auth.user!.id, 'updated', 'contract', id, { userIds });
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
