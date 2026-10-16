import { writeAudit } from '../../../lib/audit';
import { requireUser } from '../../../lib/auth';
import { getDb } from '../../../lib/db';
import { errorResponse, jsonObject } from '../../../lib/http';
import { validDate } from '../../../lib/booking-dates';

const uuid = (value: string) => /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(value);
const columns = `a.id,a.appointment_date::text AS "appointmentDate",a.end_date::text AS "endDate",to_char(a.start_time,'HH24:MI') AS "startTime",a.title,a.client_name AS "clientName",a.location,a.notes,a.assigned_user_id AS "assignedUserId",u.display_name AS "assignedUserName",a.response_status AS "responseStatus",a.response_note AS "responseNote",a.responded_at AS "respondedAt",c.display_name AS "createdByName"
   FROM appointments a LEFT JOIN users u ON u.id=a.assigned_user_id LEFT JOIN users c ON c.id=a.created_by`;
export async function GET(request: Request) {
  const auth = await requireUser();
  if (auth.response) return auth.response;
  try {
    const search = new URL(request.url).searchParams,
      user = auth.user!;
    // Sidebar badge: engineers count appointments waiting for their answer; Super Users count
    // upcoming appointments an engineer rejected, until they reassign, move or delete them.
    if (search.get('notifications') === '1') {
      const result = await getDb().query(
        `SELECT count(*)::int AS count FROM appointments WHERE end_date >= current_date AND (response_status='pending' AND assigned_user_id=$2 OR $1='super_user' AND response_status='rejected')`,
        [user.role, user.id]
      );
      return Response.json({ count: result.rows[0].count });
    }
    if (search.get('pending') === '1') {
      const result = await getDb().query(
        `SELECT ${columns}
   WHERE a.response_status='pending' AND a.assigned_user_id=$1 AND a.end_date >= current_date
   ORDER BY a.appointment_date,a.start_time NULLS LAST,a.title LIMIT 100`,
        [user.id]
      );
      return Response.json({ appointments: result.rows });
    }
    const month = search.get('month') || '';
    if (!/^\d{4}-\d{2}$/.test(month) || !validDate(month + '-01'))
      throw Error('Choose a valid calendar month.');
    const params: unknown[] = [month + '-01'];
    let access = '';
    if (user.role !== 'super_user') {
      params.push(user.id);
      access = 'AND (a.assigned_user_id=$2 OR a.created_by=$2)';
    }
    const result = await getDb().query(
      `SELECT ${columns}
   WHERE a.end_date >= $1::date AND a.appointment_date < ($1::date+interval '1 month') ${access}
   ORDER BY a.appointment_date,a.start_time NULLS LAST,a.title`,
      params
    );
    return Response.json({ appointments: result.rows });
  } catch (error) {
    return errorResponse(error);
  }
}
async function save(request: Request, editing: boolean) {
  const auth = await requireUser();
  if (auth.response) return auth.response;
  try {
    const body = await jsonObject(request),
      user = auth.user!,
      id = String(body.id || '');
    const start = String(body.appointmentDate || ''),
      end = String(body.endDate || start),
      time = String(body.startTime || ''),
      title = String(body.title || '').trim();
    if (!validDate(start) || !validDate(end) || end < start)
      throw Error('Choose valid start and end dates; the end cannot be before the start.');
    if (!title || title.length > 160)
      throw Error('Enter an appointment title (up to 160 characters).');
    if (time && !/^([01]\d|2[0-3]):[0-5]\d$/.test(time))
      throw Error('Choose a valid appointment time.');
    const assigned =
      user.role === 'super_user' ? String(body.assignedUserId || '') || null : user.id;
    if ((editing && !uuid(id)) || (assigned && !uuid(assigned)))
      throw Error('Choose a valid appointment and assigned user.');
    const strings = ['clientName', 'location', 'notes'].map(key => {
      const value = String(body[key] || '').trim();
      if (value.length > 10000) throw Error('Appointment details are too long.');
      return value;
    });
    const db = await getDb().connect();
    try {
      await db.query('BEGIN');
      const previous = editing
        ? await db.query(
            `SELECT appointment_date::text AS start,end_date::text AS "end",to_char(start_time,'HH24:MI') AS time,assigned_user_id AS assigned FROM appointments WHERE id=$1 AND ($2='super_user' OR assigned_user_id=$3 OR created_by=$3) FOR UPDATE`,
            [id, user.role, user.id]
          )
        : null;
      if (previous && !previous.rowCount)
        throw Error('Appointment not found or you cannot edit it.');
      const before = previous?.rows[0];
      // A Super User assigning (or moving) an appointment for an engineer asks the engineer to
      // accept it again. Other edits keep the engineer's existing answer.
      let response: string | null = null;
      if (
        user.role === 'super_user' &&
        (!before ||
          before.assigned !== assigned ||
          before.start !== start ||
          before.end !== end ||
          (before.time || '') !== time)
      ) {
        response = 'none';
        if (assigned && assigned !== user.id) {
          const assignee = await db.query('SELECT role FROM users WHERE id=$1 AND active=true', [
            assigned
          ]);
          if (!assignee.rowCount) throw Error('Choose an active user to assign.');
          if (assignee.rows[0].role === 'engineer') response = 'pending';
        }
      }
      const values = [start, end, time || null, title, ...strings, assigned, user.id];
      const result = editing
        ? await db.query(
            `UPDATE appointments SET appointment_date=$2,end_date=$3,start_time=$4::time,title=$5,client_name=$6,location=$7,notes=$8,assigned_user_id=$9,
               response_status=COALESCE($10::text,response_status),
               response_note=CASE WHEN $10::text IS NULL THEN response_note ELSE '' END,
               responded_at=CASE WHEN $10::text IS NULL THEN responded_at END
             WHERE id=$1 RETURNING id`,
            [id, ...values.slice(0, 8), response]
          )
        : await db.query(
            `INSERT INTO appointments(appointment_date,end_date,start_time,title,client_name,location,notes,assigned_user_id,created_by,response_status) VALUES($1,$2,$3::time,$4,$5,$6,$7,$8,$9,COALESCE($10::text,'none')) RETURNING id`,
            [...values, response]
          );
      if (!result.rowCount) throw Error('Appointment not found or you cannot edit it.');
      await writeAudit(
        db,
        user.id,
        editing ? 'updated' : 'created',
        'appointment',
        result.rows[0].id,
        {
          appointmentDate: start,
          endDate: end,
          title,
          assignedUserId: assigned,
          ...(response ? { responseStatus: response } : {})
        }
      );
      await db.query('COMMIT');
      return Response.json(
        editing
          ? { ok: true, responseStatus: response }
          : { id: result.rows[0].id, responseStatus: response },
        {
          status: editing ? 200 : 201
        }
      );
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
export async function POST(request: Request) {
  return save(request, false);
}
export async function PATCH(request: Request) {
  return save(request, true);
}
export async function DELETE(request: Request) {
  const auth = await requireUser();
  if (auth.response) return auth.response;
  try {
    const body = await jsonObject(request),
      id = String(body.id || '');
    if (!uuid(id)) throw Error('Choose a valid appointment.');
    const db = await getDb().connect();
    try {
      await db.query('BEGIN');
      const result = await db.query(
        `DELETE FROM appointments WHERE id=$1 AND ($2='super_user' OR assigned_user_id=$3 OR created_by=$3) RETURNING id`,
        [id, auth.user!.role, auth.user!.id]
      );
      if (!result.rowCount) throw Error('Appointment not found or you cannot delete it.');
      await writeAudit(db, auth.user!.id, 'deleted', 'appointment', id, {});
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
