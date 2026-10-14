import { writeAudit } from '../../../../lib/audit';
import { requireUser } from '../../../../lib/auth';
import { getDb } from '../../../../lib/db';
import { errorResponse, jsonObject } from '../../../../lib/http';

type Context = { params: Promise<{ id: string }> };

import { standardProperties } from '../../../../lib/report-fields';

export async function PATCH(request: Request, context: Context) {
  const auth = await requireUser();
  if (auth.response) return auth.response;
  try {
    const { id } = await context.params;
    const body = await jsonObject(request);
    const changes =
      body.fields && typeof body.fields === 'object' && !Array.isArray(body.fields)
        ? (body.fields as Record<string, unknown>)
        : {};
    if (!Object.keys(changes).length) throw new Error('Choose at least one field to update.');
    const db = getDb(),
      client = await db.connect();
    try {
      await client.query('BEGIN');
      const existing = await client.query(
        `SELECT rr.report_id AS "reportId",rr.device_name AS "deviceName",rr.serial_number AS "serialNumber",rr.lot_number AS "lotNumber",rr.asset_number AS "assetNumber",rr.hours_in AS "hoursIn",rr.hours_out AS "hoursOut",rr.comments,rr.values
           FROM report_rows rr
          WHERE rr.id=$1 AND ($2='super_user' OR EXISTS(SELECT 1 FROM report_assignments a WHERE a.report_id=rr.report_id AND a.user_id=$3))
          FOR UPDATE`,
        [id, auth.user!.role, auth.user!.id]
      );
      if (!existing.rowCount) {
        await client.query('ROLLBACK');
        return Response.json({ error: 'Report row not found.' }, { status: 404 });
      }
      const access = await client.query(
        `SELECT f.name,f.source_key AS "sourceKey" FROM custom_fields f WHERE f.active=true AND ($2='super_user' OR EXISTS(SELECT 1 FROM user_field_access a WHERE a.field_id=f.id AND a.user_id=$1 AND a.can_write=true))`,
        [auth.user!.id, auth.user!.role]
      );
      const writable = new Map<string, string>(
        access.rows.map((field: { name: string; sourceKey: string }) => [
          field.name,
          field.sourceKey
        ])
      );
      const permitted = Object.keys(changes).filter(field => writable.has(field));
      if (!permitted.length) {
        await client.query('ROLLBACK');
        return Response.json(
          { error: 'You do not have write access to those report fields.' },
          { status: 403 }
        );
      }
      const row = existing.rows[0] as Record<string, unknown>;
      const values = { ...((row.values || {}) as Record<string, unknown>) };
      const valueChanges: Array<{ field: string; from: string; to: string }> = [];
      for (const field of permitted) {
        const source = writable.get(field)!;
        if (source === 'Serviced') {
          const status = String(changes[field] ?? '').trim();
          const valid = await client.query(
            'SELECT name FROM service_status_options WHERE name=$1',
            [status]
          );
          if (!valid.rowCount) throw Error('Choose a valid service status.');
        }
        const property = standardProperties[source];
        valueChanges.push({
          field,
          from: String((property ? row[property] : values[source]) ?? ''),
          to: String(changes[field] ?? '')
        });
        if (property) row[property] = String(changes[field] ?? '');
        else values[source] = String(changes[field] ?? '');
      }
      await client.query(
        `UPDATE report_rows SET device_name=$2,serial_number=$3,lot_number=$4,asset_number=$5,hours_in=$6,hours_out=$7,comments=$8,values=$9::jsonb WHERE id=$1`,
        [
          id,
          row.deviceName,
          row.serialNumber,
          row.lotNumber,
          row.assetNumber,
          row.hoursIn,
          row.hoursOut,
          row.comments,
          JSON.stringify(values)
        ]
      );
      await writeAudit(client, auth.user!.id, 'updated', 'report_row', id, {
        reportId: row.reportId,
        fields: permitted,
        changes: valueChanges
      });
      await client.query('COMMIT');
      return Response.json({ ok: true, updatedFields: permitted });
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
