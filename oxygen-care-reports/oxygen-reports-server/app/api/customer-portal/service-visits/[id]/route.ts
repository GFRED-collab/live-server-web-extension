import { writeAudit } from '../../../../../lib/audit';
import { requireUser } from '../../../../../lib/auth';
import { getDb } from '../../../../../lib/db';
import { errorResponse } from '../../../../../lib/http';
type Context = { params: Promise<{ id: string }> };
const uuid = (value: string) =>
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);

/** The customer's copy of a signed service report: the same content staff print. */
export async function GET(_: Request, context: Context) {
  const auth = await requireUser(['customer']);
  if (auth.response) return auth.response;
  if (!auth.user!.canExport)
    return Response.json(
      { error: 'Your account cannot download service reports. Contact Oxygen Care.' },
      { status: 403 }
    );
  const { id } = await context.params;
  const notFound = () => Response.json({ error: 'Service report not found.' }, { status: 404 });
  if (!uuid(id)) return notFound();
  const db = await getDb().connect();
  try {
    await db.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    // Tenancy comes from the signed-in account, and only finalized visits signed by both
    // the engineer and the client are published, matching the portal's service history.
    const visit = await db.query(
      `SELECT sv.service_date::text AS "serviceDate",sv.title,sv.location,sv.summary,sv.recommendations,sv.status,ct.name AS "contractName",ct.contract_number AS "contractNumber",c.name AS "clientName",c.contact_name AS "contactName",c.email,c.phone,c.address
   FROM service_visits sv JOIN contracts ct ON ct.id=sv.contract_id JOIN clients c ON c.id=ct.client_id
   JOIN users u ON u.client_id=ct.client_id WHERE sv.id=$1 AND u.id=$2 AND u.role='customer' AND u.active=true AND sv.status='finalized'
   AND EXISTS(SELECT 1 FROM service_visit_signatures s WHERE s.service_visit_id=sv.id AND s.signer_role='engineer')
   AND EXISTS(SELECT 1 FROM service_visit_signatures s WHERE s.service_visit_id=sv.id AND s.signer_role='client')`,
      [id, auth.user!.id]
    );
    if (!visit.rowCount) {
      await db.query('ROLLBACK');
      return notFound();
    }
    const devices = await db.query(
      `SELECT d.device_name AS "deviceName",d.serial_number AS "serialNumber",d.asset_number AS "assetNumber",d.lot_number AS "lotNumber",COALESCE(svd.service_status,'Not serviced') AS "serviceStatus",COALESCE(svd.serviced,false) AS serviced,COALESCE(svd.comments,'') AS comments,
   COALESCE(jsonb_agg(jsonb_build_object('partNumber',fp.part_number,'partName',fp.part_name,'quantity',fp.quantity) ORDER BY fp.fitted_at,fp.id) FILTER(WHERE fp.id IS NOT NULL),'[]') AS parts
   FROM service_visits sv JOIN contract_devices cd ON cd.contract_id=sv.contract_id JOIN devices d ON d.id=cd.device_id
   LEFT JOIN service_visit_devices svd ON svd.service_visit_id=sv.id AND svd.device_id=d.id LEFT JOIN fitted_parts fp ON fp.service_visit_device_id=svd.id
   WHERE sv.id=$1 AND cd.added_on<=sv.service_date AND (cd.removed_on IS NULL OR cd.removed_on>=sv.service_date)
   GROUP BY d.id,svd.id ORDER BY d.device_name,d.serial_number`,
      [id]
    );
    const signatures = await db.query(
      `SELECT signer_role AS "signerRole",signer_name AS "signerName",signature_data AS "signatureData",signed_at AS "signedAt" FROM service_visit_signatures WHERE service_visit_id=$1 ORDER BY signer_role`,
      [id]
    );
    await db.query('COMMIT');
    await writeAudit(getDb(), auth.user!.id, 'exported', 'service_visit', id, {
      kind: 'customer_service_report'
    });
    return Response.json(
      { visit: visit.rows[0], devices: devices.rows, signatures: signatures.rows },
      { headers: { 'Cache-Control': 'no-store' } }
    );
  } catch (error) {
    await db.query('ROLLBACK').catch(() => {});
    return errorResponse(error);
  } finally {
    db.release();
  }
}
