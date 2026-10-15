import { requireUser } from '../../../lib/auth';
import { getDb } from '../../../lib/db';
import { writeAudit } from '../../../lib/audit';
import { errorResponse, jsonObject } from '../../../lib/http';
import { parseWorkTimes } from '../../../lib/work-times';

function text(body: Record<string, unknown>, key: string, required = false) {
  const value = String(body[key] || '').trim();
  if ((required && !value) || value.length > 10000)
    throw Error(`Check ${key.replace(/([A-Z])/g, ' $1').toLowerCase()}.`);
  return value;
}
const uuid = (value: string) =>
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);

export async function GET(request: Request) {
  const auth = await requireUser();
  if (auth.response) return auth.response;
  try {
    const user = auth.user!,
      db = getDb(),
      params = [user.role, user.id];
    if (new URL(request.url).searchParams.get('notifications') === '1') {
      const result = await db.query(
        `SELECT count(*)::int AS count FROM callouts WHERE status='open' AND ($1='super_user' OR assigned_user_id=$2)`,
        params
      );
      return Response.json({ count: result.rows[0].count });
    }
    const [callouts, dockets, engineers] = await Promise.all([
      db.query(
        `SELECT c.id,c.client_name AS "clientName",c.location,c.device_name AS "deviceName",c.serial_number AS "serialNumber",c.description,c.priority,c.status,c.assigned_user_id AS "assignedUserId",u.display_name AS "assignedUserName",c.created_at AS "createdAt" FROM callouts c JOIN users u ON u.id=c.assigned_user_id WHERE $1='super_user' OR c.assigned_user_id=$2 OR c.created_by=$2 ORDER BY c.created_at DESC`,
        params
      ),
      db.query(
        `SELECT id,'DK-'||entry_number::text AS "entryNumber",client_name AS "clientName",location,device_name AS "deviceName",serial_number AS "serialNumber",work_description AS "workDescription",engineer_name AS "engineerName",signer_name AS "signerName",signer_role AS "signerRole",signed_at AS "signedAt",started_at AS "startedAt",ended_at AS "endedAt",correction_pending AS "correctionPending",md5(to_jsonb(dockets)::text) AS version FROM dockets WHERE $1='super_user' OR created_by=$2 ORDER BY signed_at DESC`,
        params
      ),
      db.query(
        `SELECT id,display_name AS name FROM users WHERE active=true AND (($1='super_user' AND role='engineer') OR id=$2) ORDER BY display_name`,
        params
      )
    ]);
    return Response.json({
      callouts: callouts.rows,
      dockets: dockets.rows,
      engineers: engineers.rows
    });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function POST(request: Request) {
  const auth = await requireUser();
  if (auth.response) return auth.response;
  try {
    const body = await jsonObject(request),
      user = auth.user!,
      kind = String(body.kind || '');
    if (!['callout', 'docket'].includes(kind)) throw Error('Choose a call-out or docket.');
    const clientName = text(body, 'clientName', true),
      location = text(body, 'location');
    const db = await getDb().connect();
    try {
      await db.query('BEGIN');
      let id: string;
      if (kind === 'callout') {
        const assigned = user.role === 'super_user' ? text(body, 'assignedUserId', true) : user.id;
        if (!uuid(assigned)) throw Error('Choose a valid engineer.');
        const valid = await db.query(
          `SELECT id FROM users WHERE id=$1 AND active=true AND (role='engineer' OR id=$2)`,
          [assigned, user.id]
        );
        if (!valid.rowCount) throw Error('Choose an active engineer.');
        const priority = text(body, 'priority') || 'normal';
        if (!['normal', 'urgent'].includes(priority)) throw Error('Choose a valid priority.');
        const result = await db.query(
          `INSERT INTO callouts(client_name,location,description,priority,assigned_user_id,created_by,device_name,serial_number) VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
          [
            clientName,
            location,
            text(body, 'description', true),
            priority,
            assigned,
            user.id,
            text(body, 'deviceName'),
            text(body, 'serialNumber')
          ]
        );
        id = result.rows[0].id;
      } else {
        const signature = String(body.signatureData || '');
        if (
          !/^data:image\/png;base64,[A-Za-z0-9+/]+={0,2}$/.test(signature) ||
          signature.length > 750000
        )
          throw Error('Draw a valid sign-in signature.');
        const role = text(body, 'signerRole', true);
        if (role !== 'client') throw Error('A customer completion signature is required.');
        const [startedAt, endedAt] = parseWorkTimes(body.startedAt, body.endedAt);
        const calloutId = text(body, 'calloutId');
        if (calloutId) {
          if (!uuid(calloutId)) throw Error('Choose a valid call-out.');
          const access = await db.query(
            `SELECT id FROM callouts WHERE id=$1 AND ($2='super_user' OR assigned_user_id=$3 OR created_by=$3)`,
            [calloutId, user.role, user.id]
          );
          if (!access.rowCount) throw Error('Call-out is unavailable.');
        }
        const result = await db.query(
          `INSERT INTO dockets(callout_id,client_name,location,device_name,serial_number,work_description,engineer_name,signer_name,signer_role,signature_data,created_by,started_at,ended_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING id`,
          [
            calloutId || null,
            clientName,
            location,
            text(body, 'deviceName'),
            text(body, 'serialNumber'),
            text(body, 'workDescription', true),
            user.displayName,
            text(body, 'signerName', true),
            role,
            signature,
            user.id,
            startedAt,
            endedAt
          ]
        );
        id = result.rows[0].id;
      }
      await writeAudit(db, user.id, 'created', kind, id, { clientName });
      await db.query('COMMIT');
      return Response.json({ id }, { status: 201 });
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

export async function PATCH(request: Request) {
  const auth = await requireUser();
  if (auth.response) return auth.response;
  try {
    const body = await jsonObject(request),
      id = String(body.id || ''),
      status = String(body.status || '');
    if (!uuid(id) || !['acknowledged', 'closed'].includes(status))
      throw Error('Choose a valid call-out status.');
    const db = await getDb().connect();
    try {
      await db.query('BEGIN');
      const result = await db.query(
        `UPDATE callouts SET status=$2 WHERE id=$1 AND ($3='super_user' OR assigned_user_id=$4 OR created_by=$4) AND (status='open' OR (status='acknowledged' AND $2='closed')) RETURNING id`,
        [id, status, auth.user!.role, auth.user!.id]
      );
      if (!result.rowCount) throw Error('Call-out is unavailable or has already changed.');
      await writeAudit(db, auth.user!.id, 'updated', 'callout', id, { status });
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
