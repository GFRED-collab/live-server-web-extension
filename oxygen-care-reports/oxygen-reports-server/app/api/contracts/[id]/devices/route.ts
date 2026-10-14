import { writeAudit } from '../../../../../lib/audit';
import { requireUser } from '../../../../../lib/auth';
import { getDb } from '../../../../../lib/db';
import { errorResponse, jsonObject } from '../../../../../lib/http';
type Context = { params: Promise<{ id: string }> };
const identity = (serial: string, asset: string) =>
  serial ? `serial:${serial.toLowerCase()}` : asset ? `asset:${asset.toLowerCase()}` : '';

export async function POST(request: Request, context: Context) {
  const auth = await requireUser();
  if (auth.response) return auth.response;
  try {
    const { id } = await context.params,
      body = await jsonObject(request),
      serial = String(body.serialNumber || '').trim(),
      asset = String(body.assetNumber || '').trim(),
      key = identity(serial, asset);
    if (!key) throw Error('A serial number or asset number is required.');
    const db = getDb(),
      client = await db.connect();
    try {
      await client.query('BEGIN');
      const contract = await client.query(
        `SELECT ct.client_id FROM contracts ct WHERE ct.id=$1 AND ($2='super_user' OR EXISTS(SELECT 1 FROM contract_assignments ca WHERE ca.contract_id=ct.id AND ca.user_id=$3))`,
        [id, auth.user!.role, auth.user!.id]
      );
      if (!contract.rowCount) {
        await client.query('ROLLBACK');
        return Response.json({ error: 'Contract not found.' }, { status: 404 });
      }
      const created = await client.query(
        `INSERT INTO devices(client_id,identity_key,device_name,serial_number,lot_number,asset_number,purchased_on,notes) VALUES($1,$2,$3,$4,$5,$6,$7::date,$8) ON CONFLICT(client_id,identity_key) DO UPDATE SET device_name=EXCLUDED.device_name,lot_number=EXCLUDED.lot_number,asset_number=EXCLUDED.asset_number,status='active',decommissioned_on=NULL,decommission_reason='' RETURNING id`,
        [
          contract.rows[0].client_id,
          key,
          String(body.deviceName || '').trim(),
          serial,
          String(body.lotNumber || '').trim(),
          asset,
          String(body.purchasedOn || '') || null,
          String(body.notes || '').trim()
        ]
      );
      await client.query(
        `INSERT INTO contract_devices(contract_id,device_id,added_on,removed_on) VALUES($1,$2,COALESCE($3::date,CURRENT_DATE),NULL) ON CONFLICT(contract_id,device_id) DO UPDATE SET removed_on=NULL`,
        [id, created.rows[0].id, String(body.purchasedOn || '') || null]
      );
      await writeAudit(client, auth.user!.id, 'created', 'contract_device', created.rows[0].id, {
        contractId: id,
        serialNumber: serial,
        assetNumber: asset
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
