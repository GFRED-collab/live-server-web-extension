import { writeAudit } from '../../../../lib/audit';
import { requireUser } from '../../../../lib/auth';
import { getDb } from '../../../../lib/db';
import { errorResponse, jsonObject } from '../../../../lib/http';

const uuid = (value: string) => /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(value);

/** The assigned engineer accepts or rejects an appointment a Super User gave them. */
export async function POST(request: Request) {
  const auth = await requireUser();
  if (auth.response) return auth.response;
  try {
    const body = await jsonObject(request),
      user = auth.user!,
      id = String(body.id || ''),
      decision = String(body.decision || ''),
      note = String(body.note || '').trim();
    if (!uuid(id)) throw Error('Choose a valid appointment.');
    if (decision !== 'accepted' && decision !== 'rejected')
      throw Error('Choose to accept or reject the appointment.');
    if (note.length > 1000) throw Error('Keep the note to 1,000 characters.');
    if (decision === 'rejected' && !note) throw Error('Enter the reason for rejecting it.');
    const db = await getDb().connect();
    try {
      await db.query('BEGIN');
      const current = await db.query(
        'SELECT response_status AS status FROM appointments WHERE id=$1 AND assigned_user_id=$2 FOR UPDATE',
        [id, user.id]
      );
      if (!current.rowCount) throw Error('Appointment not found or it is not assigned to you.');
      if (current.rows[0].status !== 'pending')
        throw Error('This appointment has already been answered or changed. Refresh the calendar.');
      await db.query(
        'UPDATE appointments SET response_status=$2,response_note=$3,responded_at=now() WHERE id=$1',
        [id, decision, note]
      );
      await writeAudit(db, user.id, 'updated', 'appointment', id, {
        responseStatus: decision,
        ...(note ? { responseNote: note } : {})
      });
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
