import { writeAudit } from '../../../lib/audit';
import { requireUser } from '../../../lib/auth';
import { getDb } from '../../../lib/db';
import { errorResponse, jsonObject } from '../../../lib/http';

const statuses = new Set(['received', 'diagnosing', 'awaiting_parts', 'in_progress', 'follow_up', 'completed', 'returned']);
const priorities = new Set(['low', 'normal', 'high', 'urgent']);

function validateRepair(body: Record<string, unknown>) {
  if (!String(body.reportedFault || '').trim()) throw new Error('Reported fault is required.');
  for (const key of ['reportedFault','conditionReceived','workCarriedOut','partsUsed','followUpWork']) {
    if (String(body[key] || '').length > 20000) throw new Error('Repair notes must be 20,000 characters or fewer per field.');
  }
  for (const key of ['receivedDate','completedDate']) {
    const value = String(body[key] || '');
    if (value && (!/^\d{4}-\d{2}-\d{2}$/.test(value) || Number.isNaN(Date.parse(value)) || new Date(value).toISOString().slice(0,10) !== value)) throw new Error('Choose a valid calendar date.');
  }
  for (const key of ['id','clientId','engineerId']) {
    if (body[key] && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(body[key]))) throw new Error('Choose a valid record.');
  }
}

const repairSelect = `SELECT r.id,r.entry_number AS "entryNumber",r.received_date::text AS "receivedDate",
  r.client_id AS "clientId",r.client_name AS "clientName",r.device_name AS "deviceName",r.manufacturer,r.model,
  r.serial_number AS "serialNumber",r.asset_number AS "assetNumber",r.reported_fault AS "reportedFault",
  r.condition_received AS "conditionReceived",r.work_carried_out AS "workCarriedOut",r.parts_used AS "partsUsed",
  r.follow_up_work AS "followUpWork",r.status,r.priority,r.engineer_id AS "engineerId",
  r.engineer_name AS "engineerName",r.completed_date::text AS "completedDate",r.created_by AS "createdBy",
  r.created_at AS "createdAt",r.updated_at AS "updatedAt"
  FROM repair_entries r`;

export async function GET() {
  const auth = await requireUser();
  if (auth.response) return auth.response;
  const result = await getDb().query(`${repairSelect} ORDER BY r.received_date DESC,r.created_at DESC`);
  return Response.json({ repairs: result.rows });
}

export async function POST(request: Request) {
  const auth = await requireUser();
  if (auth.response) return auth.response;
  try {
    const body = await jsonObject(request);
    validateRepair(body);
    const receivedDate = String(body.receivedDate || '');
    const deviceName = String(body.deviceName || '').trim();
    const reportedFault = String(body.reportedFault || '').trim();
    const status = String(body.status || 'received');
    const priority = String(body.priority || 'normal');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(receivedDate) || !deviceName || !reportedFault) throw new Error('Received date, device or machine, and reported fault are required.');
    if (!statuses.has(status) || !priorities.has(priority)) throw new Error('Choose a valid repair status and priority.');
    if (deviceName.length > 160) throw new Error('Device name must be 160 characters or fewer.');
    if (body.completedDate && String(body.completedDate) < receivedDate) throw new Error('Completion date cannot precede receipt.');
    const db = getDb();
    const created = await db.query(
      `INSERT INTO repair_entries(entry_number,received_date,client_id,client_name,device_name,manufacturer,model,serial_number,asset_number,reported_fault,condition_received,work_carried_out,parts_used,follow_up_work,status,priority,engineer_id,engineer_name,completed_date,created_by)
       VALUES('RR-' || to_char(current_date,'YYYY') || '-' || lpad(nextval('repair_entry_number_seq')::text,6,'0'),$1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)
       RETURNING id,entry_number AS "entryNumber"`,
      [receivedDate, String(body.clientId || '') || null, String(body.clientName || '').trim(), deviceName, String(body.manufacturer || '').trim(), String(body.model || '').trim(), String(body.serialNumber || '').trim(), String(body.assetNumber || '').trim(), reportedFault, String(body.conditionReceived || '').trim(), String(body.workCarriedOut || '').trim(), String(body.partsUsed || '').trim(), String(body.followUpWork || '').trim(), status, priority, String(body.engineerId || '') || null, String(body.engineerName || auth.user!.displayName).trim(), String(body.completedDate || '') || null, auth.user!.id],
    );
    await writeAudit(db, auth.user!.id, 'created', 'repair_entry', created.rows[0].id, { entryNumber: created.rows[0].entryNumber, deviceName, status });
    return Response.json(created.rows[0], { status: 201 });
  } catch (error) { return errorResponse(error); }
}

export async function PATCH(request: Request) {
  const auth = await requireUser();
  if (auth.response) return auth.response;
  try {
    const body = await jsonObject(request), id = String(body.id || '');
    validateRepair(body);
    const status = String(body.status || ''), priority = String(body.priority || '');
    if (!id || !statuses.has(status) || !priorities.has(priority)) throw new Error('A valid repair entry, status and priority are required.');
    const db = getDb();
    const allowed = await db.query(`SELECT id,received_date::text AS "receivedDate" FROM repair_entries WHERE id=$1 AND ($2='super_user' OR created_by=$3 OR engineer_id=$3)`, [id, auth.user!.role, auth.user!.id]);
    if (!allowed.rowCount) return Response.json({ error: 'Repair entry not found or you cannot edit it.' }, { status: 404 });
    if (body.completedDate && String(body.completedDate) < allowed.rows[0].receivedDate) throw new Error('Completion date cannot precede receipt.');
    await db.query(
      `UPDATE repair_entries SET reported_fault=$2,condition_received=$3,work_carried_out=$4,parts_used=$5,follow_up_work=$6,status=$7,priority=$8,engineer_id=$9,engineer_name=$10,completed_date=$11 WHERE id=$1`,
      [id, String(body.reportedFault || '').trim(), String(body.conditionReceived || '').trim(), String(body.workCarriedOut || '').trim(), String(body.partsUsed || '').trim(), String(body.followUpWork || '').trim(), status, priority, String(body.engineerId || '') || null, String(body.engineerName || '').trim(), String(body.completedDate || '') || null],
    );
    await writeAudit(db, auth.user!.id, 'updated', 'repair_entry', id, { status, followUpWork: String(body.followUpWork || '').trim() });
    return Response.json({ ok: true });
  } catch (error) { return errorResponse(error); }
}
