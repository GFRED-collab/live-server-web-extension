import { writeAudit } from '../../../lib/audit';
import { requireUser } from '../../../lib/auth';
import { getDb } from '../../../lib/db';
import { errorResponse, jsonObject } from '../../../lib/http';
import { validDate } from '../../../lib/booking-dates';

const uuid = (value: string) => /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(value);
export async function GET(request: Request) {
  const auth = await requireUser();
  if (auth.response) return auth.response;
  try {
    const month = new URL(request.url).searchParams.get('month') || '';
    if (!/^\d{4}-\d{2}$/.test(month) || !validDate(month + '-01'))
      throw Error('Choose a valid calendar month.');
    const user = auth.user!,
      params: unknown[] = [month + '-01'];
    let access = '';
    if (user.role !== 'super_user') {
      params.push(user.id);
      access = 'AND (a.assigned_user_id=$2 OR a.created_by=$2)';
    }
    const result = await getDb().query(
      `SELECT a.id,a.appointment_date::text AS "appointmentDate",a.end_date::text AS "endDate",to_char(a.start_time,'HH24:MI') AS "startTime",a.title,a.client_name AS "clientName",a.location,a.notes,a.assigned_user_id AS "assignedUserId",u.display_name AS "assignedUserName"
   FROM appointments a LEFT JOIN users u ON u.id=a.assigned_user_id
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
      const values = [start, end, time || null, title, ...strings, assigned, user.id];
      const result = editing
        ? await db.query(
            `UPDATE appointments SET appointment_date=$2,end_date=$3,start_time=$4::time,title=$5,client_name=$6,location=$7,notes=$8,assigned_user_id=$9 WHERE id=$1 AND ($10='super_user' OR assigned_user_id=$11 OR created_by=$11) RETURNING id`,
            [id, ...values.slice(0, 8), user.role, user.id]
          )
        : await db.query(
            `INSERT INTO appointments(appointment_date,end_date,start_time,title,client_name,location,notes,assigned_user_id,created_by) VALUES($1,$2,$3::time,$4,$5,$6,$7,$8,$9) RETURNING id`,
            values
          );
      if (!result.rowCount) throw Error('Appointment not found or you cannot edit it.');
      await writeAudit(
        db,
        user.id,
        editing ? 'updated' : 'created',
        'appointment',
        result.rows[0].id,
        { appointmentDate: start, endDate: end, title, assignedUserId: assigned }
      );
      await db.query('COMMIT');
      return Response.json(editing ? { ok: true } : { id: result.rows[0].id }, {
        status: editing ? 200 : 201
      });
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
