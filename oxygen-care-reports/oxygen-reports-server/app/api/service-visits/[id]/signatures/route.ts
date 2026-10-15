import { writeAudit } from '../../../../../lib/audit';
import { requireUser } from '../../../../../lib/auth';
import { getDb } from '../../../../../lib/db';
import { errorResponse, jsonObject } from '../../../../../lib/http';
type Context = { params: Promise<{ id: string }> };
export async function POST(request: Request, context: Context) {
  const auth = await requireUser();
  if (auth.response) return auth.response;
  try {
    const { id } = await context.params,
      body = await jsonObject(request),
      signerRole = String(body.signerRole || ''),
      signerName = String(body.signerName || '').trim(),
      signatureData = String(body.signatureData || '');
    if (!['engineer', 'client'].includes(signerRole) || !signerName)
      throw Error('Signer role and printed name are required.');
    if (!signatureData.startsWith('data:image/png;base64,') || signatureData.length > 750000)
      throw Error('Draw a valid signature before saving.');
    const db = getDb();
    const access = await db.query(
      `SELECT sv.status FROM service_visits sv JOIN contracts ct ON ct.id=sv.contract_id WHERE sv.id=$1 AND ($2='super_user' OR EXISTS(SELECT 1 FROM contract_assignments ca WHERE ca.contract_id=ct.id AND ca.user_id=$3))`,
      [id, auth.user!.role, auth.user!.id]
    );
    if (!access.rowCount)
      return Response.json({ error: 'Service visit not found.' }, { status: 404 });
    if (access.rows[0].status === 'finalized')
      throw Error('Finalized service visits cannot be signed again.');
    const saved = await db.query(
      `INSERT INTO service_visit_signatures(service_visit_id,signer_role,signer_name,signature_data) VALUES($1,$2,$3,$4) ON CONFLICT(service_visit_id,signer_role) DO UPDATE SET signer_name=EXCLUDED.signer_name,signature_data=EXCLUDED.signature_data,signed_at=now() RETURNING id`,
      [id, signerRole, signerName, signatureData]
    );
    await writeAudit(db, auth.user!.id, 'updated', 'service_signature', saved.rows[0].id, {
      serviceVisitId: id,
      signerRole,
      signerName
    });
    return Response.json({ id: saved.rows[0].id });
  } catch (error) {
    return errorResponse(error);
  }
}
