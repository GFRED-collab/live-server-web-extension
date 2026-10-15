import { writeAudit } from '../../../../lib/audit';
import { requireUser } from '../../../../lib/auth';
import { getDb } from '../../../../lib/db';
import { errorResponse, jsonObject } from '../../../../lib/http';
type Context = { params: Promise<{ id: string }> };
import { secureReportRow } from '../../../../lib/report-fields';
export async function GET(_: Request, context: Context) {
  const auth = await requireUser();
  if (auth.response) return auth.response;
  const { id } = await context.params,
    user = auth.user!,
    db = getDb();
  if (user.role !== 'super_user') {
    const assigned = await db.query(
      `SELECT 1 FROM report_assignments WHERE report_id=$1 AND user_id=$2`,
      [id, user.id]
    );
    if (!assigned.rowCount) return Response.json({ error: 'Report not found.' }, { status: 404 });
  }
  const [report, rows] = await Promise.all([
    db.query(
      `SELECT id,client_name AS "clientName",original_filename AS "originalFilename",uploaded_at AS "uploadedAt" FROM reports WHERE id=$1`,
      [id]
    ),
    db.query(
      `SELECT id,device_name AS "deviceName",serial_number AS "serialNumber",lot_number AS "lotNumber",asset_number AS "assetNumber",hours_in AS "hoursIn",hours_out AS "hoursOut",comments,values FROM report_rows WHERE report_id=$1 ORDER BY created_at`,
      [id]
    )
  ]);
  if (!report.rowCount) return Response.json({ error: 'Report not found.' }, { status: 404 });
  if (user.role === 'super_user') return Response.json({ report: report.rows[0], rows: rows.rows });
  const access = await db.query(
    `SELECT f.source_key AS "sourceKey" FROM user_field_access a JOIN custom_fields f ON f.id=a.field_id WHERE a.user_id=$1 AND (a.can_read OR a.can_write) AND f.active=true`,
    [user.id]
  );
  const allowed = new Set<string>(
    access.rows.map((field: { sourceKey: string }) => field.sourceKey)
  );
  const secured = rows.rows.map((row: Record<string, unknown>) => secureReportRow(row, allowed));
  return Response.json({ report: report.rows[0], rows: secured });
}
export async function PATCH(request: Request, context: Context) {
  const auth = await requireUser(['super_user']);
  if (auth.response) return auth.response;
  try {
    const { id } = await context.params,
      body = await jsonObject(request),
      userIds = Array.isArray(body.userIds) ? body.userIds.map(String) : [],
      db = getDb(),
      client = await db.connect();
    try {
      await client.query('BEGIN');
      await client.query('DELETE FROM report_assignments WHERE report_id=$1', [id]);
      for (const userId of userIds)
        await client.query(
          `INSERT INTO report_assignments(report_id,user_id,assigned_by) VALUES($1,$2,$3)`,
          [id, userId, auth.user!.id]
        );
      await writeAudit(client, auth.user!.id, 'assigned', 'report', id, { userIds });
      await client.query('COMMIT');
      return Response.json({ ok: true });
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  } catch (error) {
    return errorResponse(error);
  }
}
