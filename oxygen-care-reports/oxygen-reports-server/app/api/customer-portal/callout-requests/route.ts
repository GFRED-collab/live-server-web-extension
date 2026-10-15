import { writeAudit } from '../../../../lib/audit';
import { requireUser } from '../../../../lib/auth';
import { getDb } from '../../../../lib/db';
import { errorResponse, jsonObject } from '../../../../lib/http';

const uuid = (value: string) =>
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
const maxOpenRequests = 10;

function text(body: Record<string, unknown>, key: string, label: string, max: number) {
  const value = typeof body[key] === 'string' ? (body[key] as string).trim() : '';
  if (value.length > max) throw Error(`${label} must be ${max} characters or fewer.`);
  return value;
}

// Customers see the outcome of their request, never staff-only callout details.
const requestColumns = `r.id,'CR-'||r.reference::text AS reference,r.contract_id AS "contractId",r.device_id AS "deviceId",r.description,r.priority,r.location,
 r.contact_name AS "contactName",r.contact_phone AS "contactPhone",r.status,r.decline_reason AS "declineReason",r.created_at AS "createdAt",r.decided_at AS "decidedAt",
 c.status AS "calloutStatus"`;

export async function GET() {
  const auth = await requireUser(['customer']);
  if (auth.response) return auth.response;
  try {
    const result = await getDb().query(
      `SELECT ${requestColumns} FROM callout_requests r LEFT JOIN callouts c ON c.id=r.callout_id
   JOIN users u ON u.client_id=r.client_id WHERE u.id=$1 AND u.role='customer' AND u.active=true
   ORDER BY r.created_at DESC LIMIT 200`,
      [auth.user!.id]
    );
    return Response.json({ requests: result.rows }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function POST(request: Request) {
  const auth = await requireUser(['customer']);
  if (auth.response) return auth.response;
  try {
    const body = await jsonObject(request);
    const description = text(body, 'description', 'The description', 2000);
    if (!description) throw Error('Describe the problem so we can send the right engineer.');
    const priority = body.priority === 'urgent' ? 'urgent' : 'normal';
    const location = text(body, 'location', 'The location', 300),
      contactName = text(body, 'contactName', 'The contact name', 200),
      contactPhone = text(body, 'contactPhone', 'The contact phone', 50);
    const contractId = text(body, 'contractId', 'The contract', 36) || null,
      deviceId = text(body, 'deviceId', 'The device', 36) || null;
    if ((contractId && !uuid(contractId)) || (deviceId && !uuid(deviceId)))
      throw Error('Choose a contract and device from the list.');
    if (deviceId && !contractId) throw Error('Choose the contract for this device.');
    const db = await getDb().connect();
    try {
      await db.query('BEGIN');
      // The client comes from the signed-in account; the row lock serialises the open-request limit.
      const account = await db.query(
        `SELECT c.id FROM clients c JOIN users u ON u.client_id=c.id WHERE u.id=$1 AND u.role='customer' AND u.active=true FOR UPDATE OF c`,
        [auth.user!.id]
      );
      if (!account.rowCount) {
        await db.query('ROLLBACK');
        return Response.json({ error: 'Customer access is not configured.' }, { status: 403 });
      }
      const clientId = account.rows[0].id;
      if (contractId) {
        const owned = await db.query(
          deviceId
            ? `SELECT 1 FROM contracts ct JOIN contract_devices cd ON cd.contract_id=ct.id JOIN devices d ON d.id=cd.device_id AND d.client_id=ct.client_id
   WHERE ct.id=$1 AND ct.client_id=$2 AND d.id=$3 AND cd.removed_on IS NULL`
            : `SELECT 1 FROM contracts ct WHERE ct.id=$1 AND ct.client_id=$2`,
          deviceId ? [contractId, clientId, deviceId] : [contractId, clientId]
        );
        if (!owned.rowCount) throw Error('Choose a contract and device from the list.');
      }
      const open = await db.query(
        `SELECT count(*)::int AS count FROM callout_requests WHERE client_id=$1 AND status='new'`,
        [clientId]
      );
      if (open.rows[0].count >= maxOpenRequests)
        throw Error(
          `You already have ${maxOpenRequests} requests waiting for review. Please call Oxygen Care if this is urgent.`
        );
      const created = await db.query(
        `INSERT INTO callout_requests(client_id,contract_id,device_id,description,priority,location,contact_name,contact_phone,requested_by)
   VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id,'CR-'||reference::text AS reference`,
        [
          clientId,
          contractId,
          deviceId,
          description,
          priority,
          location,
          contactName,
          contactPhone,
          auth.user!.id
        ]
      );
      await writeAudit(db, auth.user!.id, 'created', 'callout_request', created.rows[0].id, {
        priority
      });
      await db.query('COMMIT');
      return Response.json(created.rows[0], { status: 201 });
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
