import { writeAudit } from '../../../../../../lib/audit';
import { requireUser } from '../../../../../../lib/auth';
import { getDb } from '../../../../../../lib/db';
import { errorResponse, jsonObject } from '../../../../../../lib/http';
type Context = { params: Promise<{ id: string; deviceId: string }> };
export async function PATCH(request: Request, context: Context) {
  const auth = await requireUser();
  if (auth.response) return auth.response;
  try {
    const { id, deviceId } = await context.params,
      body = await jsonObject(request),
      status = String(body.status || '');
    if (!['active', 'decommissioned'].includes(status))
      throw Error('Choose active or decommissioned status.');
    const db = getDb(),
      client = await db.connect();
    try {
      await client.query('BEGIN');
      const access = await client.query(
        `SELECT 1 FROM contracts ct JOIN contract_devices cd ON cd.contract_id=ct.id AND cd.device_id=$2 WHERE ct.id=$1 AND ($3='super_user' OR EXISTS(SELECT 1 FROM contract_assignments ca WHERE ca.contract_id=ct.id AND ca.user_id=$4))`,
        [id, deviceId, auth.user!.role, auth.user!.id]
      );
      if (!access.rowCount)
        return Response.json({ error: 'Contract device not found.' }, { status: 404 });
      await client.query(
        `UPDATE devices SET status=$2,decommissioned_on=CASE WHEN $2='decommissioned' THEN COALESCE($3::date,CURRENT_DATE) ELSE NULL END,decommission_reason=CASE WHEN $2='decommissioned' THEN $4 ELSE '' END WHERE id=$1`,
        [
          deviceId,
          status,
          String(body.decommissionedOn || '') || null,
          String(body.reason || '').trim()
        ]
      );
      await client.query(
        `UPDATE contract_devices SET removed_on=CASE WHEN $3='decommissioned' THEN COALESCE($4::date,CURRENT_DATE) ELSE NULL END WHERE contract_id=$1 AND device_id=$2`,
        [id, deviceId, status, String(body.decommissionedOn || '') || null]
      );
      await writeAudit(client, auth.user!.id, 'updated', 'contract_device', deviceId, {
        contractId: id,
        status,
        reason: String(body.reason || '').trim()
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
