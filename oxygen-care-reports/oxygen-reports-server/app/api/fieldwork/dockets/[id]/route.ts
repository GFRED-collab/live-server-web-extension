import { requireUser } from '../../../../../lib/auth';
import { getDb } from '../../../../../lib/db';
import { writeAudit } from '../../../../../lib/audit';
import { errorResponse, jsonObject } from '../../../../../lib/http';
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireUser();
  if (auth.response) return auth.response;
  const { id } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(id))
    return Response.json({ error: 'Invalid docket.' }, { status: 400 });
  const result = await getDb().query(
    `SELECT signature_data AS "signatureData",correction_pending AS "correctionPending",jsonb_build_object('startedAt',started_at,'endedAt',ended_at,'clientName',client_name,'location',location,'deviceName',device_name,'serialNumber',serial_number,'workDescription',work_description,'engineerName',engineer_name,'signerName',signer_name,'signedAt',signed_at) AS docket FROM dockets WHERE id=$1 AND ($2='super_user' OR created_by=$3)`,
    [id, auth.user!.role, auth.user!.id]
  );
  if (!result.rowCount) return Response.json({ error: 'Docket not found.' }, { status: 404 });
  return Response.json(result.rows[0]);
}

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireUser();
  if (auth.response) return auth.response;
  try {
    const { id } = await params,
      body = await jsonObject(request),
      signature = String(body.signatureData || ''),
      name = String(body.signerName || '').trim();
    if (
      !/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(id) ||
      !name ||
      name.length > 160 ||
      !/^data:image\/png;base64,[A-Za-z0-9+/]+={0,2}$/.test(signature) ||
      signature.length > 750000
    )
      throw Error('Enter the customer name and draw a completion signature.');
    const db = await getDb().connect();
    try {
      await db.query('BEGIN');
      const existing = await db.query(
        `SELECT to_jsonb(d) AS record,md5(to_jsonb(d)::text) AS version FROM dockets d WHERE id=$1 AND correction_pending=true AND ($2='super_user' OR created_by=$3) FOR UPDATE`,
        [id, auth.user!.role, auth.user!.id]
      );
      if (!existing.rowCount)
        throw Error('This docket is unavailable or no longer needs a signature.');
      if (body.version !== existing.rows[0].version)
        throw Error('The docket changed. Refresh before signing.');
      await db.query(
        `INSERT INTO admin_entry_history(entity_type,entity_id,operation,reason,snapshot,actor_id) VALUES('dockets',$1,'updated','Customer signed corrected docket',$2::jsonb,$3)`,
        [id, JSON.stringify(existing.rows[0].record), auth.user!.id]
      );
      await db.query(
        `UPDATE dockets SET signer_name=$2,signer_role='client',signature_data=$3,signed_at=now(),correction_pending=false WHERE id=$1`,
        [id, name, signature]
      );
      await writeAudit(db, auth.user!.id, 'updated', 'docket', id, { customerResigned: true });
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
