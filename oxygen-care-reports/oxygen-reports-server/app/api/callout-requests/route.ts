import { requireUser } from '../../../lib/auth';
import { getDb } from '../../../lib/db';
import { errorResponse } from '../../../lib/http';

/** Customer callout requests for Super Users to review: new requests first, then recent decisions. */
export async function GET() {
  const auth = await requireUser(['super_user']);
  if (auth.response) return auth.response;
  try {
    const result = await getDb().query(
      `SELECT r.id,'CR-'||r.reference::text AS reference,r.status,r.priority,r.description,r.location,r.contact_name AS "contactName",r.contact_phone AS "contactPhone",
   r.decline_reason AS "declineReason",r.created_at AS "createdAt",r.decided_at AS "decidedAt",r.callout_id AS "calloutId",
   cl.name AS "clientName",ct.name AS "contractName",ct.contract_number AS "contractNumber",d.device_name AS "deviceName",d.serial_number AS "serialNumber",
   req.display_name AS "requestedByName",req.email::text AS "requestedByEmail",dec.display_name AS "decidedByName"
   FROM callout_requests r JOIN clients cl ON cl.id=r.client_id LEFT JOIN contracts ct ON ct.id=r.contract_id LEFT JOIN devices d ON d.id=r.device_id
   LEFT JOIN users req ON req.id=r.requested_by LEFT JOIN users dec ON dec.id=r.decided_by
   WHERE r.status='new' OR r.decided_at > now() - interval '30 days'
   ORDER BY (r.status='new') DESC,(r.priority='urgent') DESC,r.created_at DESC LIMIT 500`
    );
    return Response.json({ requests: result.rows }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    return errorResponse(error);
  }
}
