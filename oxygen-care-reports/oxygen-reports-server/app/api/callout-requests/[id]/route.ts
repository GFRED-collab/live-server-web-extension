import { writeAudit } from '../../../../lib/audit';
import { requireUser } from '../../../../lib/auth';
import { getDb } from '../../../../lib/db';
import { errorResponse, jsonObject } from '../../../../lib/http';
type Context = { params: Promise<{ id: string }> };
const uuid = (value: string) =>
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);

/** Accept a request (creating a callout for an engineer) or decline it with a reason. */
export async function PATCH(request: Request, context: Context) {
  const auth = await requireUser(['super_user']);
  if (auth.response) return auth.response;
  try {
    const { id } = await context.params;
    if (!uuid(id)) return Response.json({ error: 'Request not found.' }, { status: 404 });
    const body = await jsonObject(request),
      action = body.action;
    if (action !== 'accept' && action !== 'decline') throw Error('Choose accept or decline.');
    const assignedUserId = typeof body.assignedUserId === 'string' ? body.assignedUserId : '',
      reason = typeof body.reason === 'string' ? body.reason.trim() : '';
    if (action === 'accept' && !uuid(assignedUserId)) throw Error('Choose an engineer.');
    if (action === 'decline' && !reason) throw Error('Give the customer a reason for declining.');
    if (reason.length > 1000) throw Error('The reason must be 1000 characters or fewer.');
    const db = await getDb().connect();
    try {
      await db.query('BEGIN');
      const locked = await db.query(
        `SELECT r.status,r.description,r.priority,r.location,r.contact_name AS "contactName",r.contact_phone AS "contactPhone",'CR-'||r.reference::text AS reference,
   cl.name AS "clientName",cl.address,COALESCE(d.device_name,'') AS "deviceName",COALESCE(d.serial_number,'') AS "serialNumber"
   FROM callout_requests r JOIN clients cl ON cl.id=r.client_id LEFT JOIN devices d ON d.id=r.device_id WHERE r.id=$1 FOR UPDATE OF r`,
        [id]
      );
      if (!locked.rowCount) {
        await db.query('ROLLBACK');
        return Response.json({ error: 'Request not found.' }, { status: 404 });
      }
      const req = locked.rows[0];
      if (req.status !== 'new')
        throw Error('This request has already been handled. Refresh the list.');
      if (action === 'decline') {
        await db.query(
          `UPDATE callout_requests SET status='declined',decline_reason=$2,decided_by=$3,decided_at=now() WHERE id=$1`,
          [id, reason, auth.user!.id]
        );
        await writeAudit(db, auth.user!.id, 'updated', 'callout_request', id, {
          status: 'declined'
        });
        await db.query('COMMIT');
        return Response.json({ status: 'declined' });
      }
      const engineer = await db.query(
        `SELECT 1 FROM users WHERE id=$1 AND active=true AND role='engineer'`,
        [assignedUserId]
      );
      if (!engineer.rowCount) throw Error('Choose an active engineer.');
      const contact = [req.contactName, req.contactPhone].filter(Boolean).join(' · ');
      const description = [
        req.description,
        contact && `Customer contact: ${contact}`,
        `Requested through the customer portal (${req.reference}).`
      ]
        .filter(Boolean)
        .join('\n\n');
      const callout = await db.query(
        `INSERT INTO callouts(client_name,location,description,priority,assigned_user_id,created_by,device_name,serial_number) VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
        [
          req.clientName,
          req.location || req.address || '',
          description,
          req.priority,
          assignedUserId,
          auth.user!.id,
          req.deviceName,
          req.serialNumber
        ]
      );
      const calloutId = callout.rows[0].id;
      await db.query(
        `UPDATE callout_requests SET status='accepted',callout_id=$2,decided_by=$3,decided_at=now() WHERE id=$1`,
        [id, calloutId, auth.user!.id]
      );
      await writeAudit(db, auth.user!.id, 'created', 'callout', calloutId, {
        calloutRequestId: id,
        assignedUserId
      });
      await db.query('COMMIT');
      return Response.json({ status: 'accepted', calloutId });
    } catch (error) {
      await db.query('ROLLBACK').catch(() => {});
      throw error;
    } finally {
      db.release();
    }
  } catch (error) {
    return errorResponse(error);
  }
}
