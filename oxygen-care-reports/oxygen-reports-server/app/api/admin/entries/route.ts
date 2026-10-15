import { requireUser } from '../../../../lib/auth';
import { getDb } from '../../../../lib/db';
import { writeAudit } from '../../../../lib/audit';
import { errorResponse, jsonObject } from '../../../../lib/http';
import { entryDefinitions } from '../../../../lib/entry-definitions';
import type { PoolClient } from 'pg';
import { parseWorkTimes } from '../../../../lib/work-times';
import { validateClientName } from '../../../../lib/client-name';

const uuid = (value: string) => /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(value);
const quote = (value: string) => '"' + value.replace(/"/g, '""') + '"';
function definition(kind: string) {
  if (!Object.hasOwn(entryDefinitions, kind)) throw Error('Unknown entry type.');
  return entryDefinitions[kind];
}
async function visitSnapshot(db: PoolClient, id: string) {
  const result = await db.query(
    `SELECT to_jsonb(sv) AS visit,to_jsonb(ct) AS contract,to_jsonb(c) AS client,
    (SELECT COALESCE(jsonb_agg(to_jsonb(s)),'[]') FROM service_visit_signatures s WHERE s.service_visit_id=sv.id) AS signatures,
    (SELECT COALESCE(jsonb_agg(jsonb_build_object('record',to_jsonb(r),'device',to_jsonb(d),'parts',
      (SELECT COALESCE(jsonb_agg(to_jsonb(p)),'[]') FROM fitted_parts p WHERE p.service_visit_device_id=r.id))),'[]')
      FROM contract_devices cd JOIN devices d ON d.id=cd.device_id LEFT JOIN service_visit_devices r ON r.service_visit_id=sv.id AND r.device_id=d.id WHERE cd.contract_id=sv.contract_id AND cd.added_on<=sv.service_date AND (cd.removed_on IS NULL OR cd.removed_on>=sv.service_date)) AS devices
    FROM service_visits sv JOIN contracts ct ON ct.id=sv.contract_id JOIN clients c ON c.id=ct.client_id WHERE sv.id=$1`,
    [id]
  );
  return result.rows[0];
}
// Saved-entry lists show 20 entries per page.
const pageSize = 20;

export async function GET(request: Request) {
  const auth = await requireUser(['super_user']);
  if (auth.response) return auth.response;
  try {
    const url = new URL(request.url),
      kind = url.searchParams.get('kind') || 'callouts',
      def = definition(kind),
      db = getDb();
    const search = (url.searchParams.get('search') || '').slice(0, 200);
    const page = Math.min(
      100000,
      Math.max(0, Math.floor(Number(url.searchParams.get('page')) || 0))
    );
    if (url.searchParams.get('history') === '1') {
      const id = url.searchParams.get('id');
      if (id && !uuid(id)) throw Error('Choose a valid entry.');
      const result = await db.query(
        `SELECT id,entity_id AS "entityId",operation,reason,recorded_at AS "recordedAt",snapshot
        FROM admin_entry_history WHERE entity_type=$1 AND ($2::uuid IS NULL OR entity_id=$2::uuid)
        AND (reason ILIKE $3 OR snapshot::text ILIKE $3) ORDER BY recorded_at DESC LIMIT $5 OFFSET $4`,
        [kind, id, '%' + search + '%', page * pageSize, pageSize + 1]
      );
      return Response.json({
        history: result.rows.slice(0, pageSize),
        hasMore: result.rows.length > pageSize
      });
    }
    const columns = def.fields.map(f => quote(f.name)).join(',');
    const result = await db.query(
      `SELECT id,${columns},md5(to_jsonb(t)::text) AS version
      FROM ${quote(kind)} t WHERE concat_ws(' ',${columns}) ILIKE $1 ORDER BY id LIMIT $3 OFFSET $2`,
      ['%' + search + '%', page * pageSize, pageSize + 1]
    );
    return Response.json({
      entries: result.rows.slice(0, pageSize),
      hasMore: result.rows.length > pageSize
    });
  } catch (error) {
    return errorResponse(error);
  }
}
async function adjustMovement(db: PoolClient, original: Record<string, unknown>, delta: number) {
  if (!delta) return;
  await db.query('SELECT id FROM spare_parts WHERE id=$1 FOR UPDATE', [original.part_id]);
  const quantity = Math.abs(delta);
  if (original.movement === 'assigned' && delta > 0) {
    const reduced = await db.query(
      'UPDATE spare_parts SET warehouse_quantity=warehouse_quantity-$2 WHERE id=$1 AND warehouse_quantity >= $2',
      [original.part_id, quantity]
    );
    if (!reduced.rowCount) throw Error('Not enough warehouse stock for this correction.');
  }
  if (
    (original.movement === 'assigned' && delta < 0) ||
    (original.movement === 'fitted' && delta > 0)
  ) {
    const reduced = await db.query(
      'UPDATE engineer_stock SET quantity=quantity-$3 WHERE engineer_id=$1 AND part_id=$2 AND quantity >= $3',
      [original.engineer_id, original.part_id, quantity]
    );
    if (!reduced.rowCount)
      throw Error('Not enough engineer stock to reverse or correct this movement.');
  } else {
    await db.query(
      `INSERT INTO engineer_stock(engineer_id,part_id,quantity) VALUES($1,$2,$3)
      ON CONFLICT(engineer_id,part_id) DO UPDATE SET quantity=engineer_stock.quantity+EXCLUDED.quantity`,
      [original.engineer_id, original.part_id, quantity]
    );
  }
  if (original.movement === 'assigned' && delta < 0)
    await db.query('UPDATE spare_parts SET warehouse_quantity=warehouse_quantity+$2 WHERE id=$1', [
      original.part_id,
      quantity
    ]);
}

async function mutate(request: Request, remove: boolean) {
  const auth = await requireUser(['super_user']);
  if (auth.response) return auth.response;
  try {
    const body = await jsonObject(request),
      kind = String(body.kind || ''),
      def = definition(kind),
      id = String(body.id || '');
    const reason = String(body.reason || '').trim();
    if (!uuid(id) || !reason || reason.length > 1000)
      throw Error('Choose an entry and give a reason (up to 1,000 characters).');
    if (!remove && (!body.fields || typeof body.fields !== 'object' || Array.isArray(body.fields)))
      throw Error('Entry fields are required.');
    const fields = body.fields as Record<string, unknown>;
    if (!remove && kind === 'clients' && Object.hasOwn(fields, 'name'))
      fields.name = validateClientName(fields.name);
    if (!remove && kind === 'reports' && Object.hasOwn(fields, 'client_name'))
      fields.client_name = validateClientName(fields.client_name);
    if (!remove && Object.keys(fields).some(key => !def.fields.some(f => f.name === key)))
      throw Error('An unsupported field was supplied.');
    const db = await getDb().connect();
    try {
      await db.query('BEGIN');
      const result = await db.query(
        `SELECT to_jsonb(t) AS record,md5(to_jsonb(t)::text) AS version FROM ${quote(kind)} t WHERE id=$1 FOR UPDATE`,
        [id]
      );
      if (!result.rowCount) throw Error('Entry no longer exists.');
      if (result.rows[0].version !== body.version)
        throw Error('This entry changed. Refresh before trying again.');
      const original = result.rows[0].record;
      // Shared client/device details appear on signed service forms. Reopen affected
      // visits first so a correction cannot silently alter a customer-approved form.
      const signedGuard: Record<string, string> = {
        clients: 'ct.client_id=$1',
        contracts: 'ct.id=$1',
        devices:
          'EXISTS(SELECT 1 FROM service_visit_devices d WHERE d.service_visit_id=sv.id AND d.device_id=$1)',
        reports: 'sv.source_report_id=$1',
        report_rows:
          'EXISTS(SELECT 1 FROM service_visit_devices d WHERE d.service_visit_id=sv.id AND d.source_report_row_id=$1)',
        service_visit_devices:
          'EXISTS(SELECT 1 FROM service_visit_devices d WHERE d.service_visit_id=sv.id AND d.id=$1)',
        fitted_parts:
          'EXISTS(SELECT 1 FROM service_visit_devices d JOIN fitted_parts p ON p.service_visit_device_id=d.id WHERE d.service_visit_id=sv.id AND p.id=$1)'
      };
      if (signedGuard[kind]) {
        const signed = await db.query(
          `SELECT sv.id FROM service_visits sv JOIN contracts ct ON ct.id=sv.contract_id
          WHERE ${signedGuard[kind]} AND (sv.status='finalized' OR EXISTS(SELECT 1 FROM service_visit_signatures s WHERE s.service_visit_id=sv.id)) LIMIT 1`,
          [id]
        );
        if (signed.rowCount)
          throw Error(
            'This entry belongs to a signed service visit. Correct that service visit first; its original is preserved and it reopens for fresh signatures.'
          );
      }
      const snapshot = kind === 'service_visits' ? await visitSnapshot(db, id) : original;
      if (remove && kind === 'stock_movements')
        await adjustMovement(db, original, -Number(original.quantity));
      if (remove) {
        // Protect business links even where the database would CASCADE or SET NULL.
        const refs = await db.query(
          `SELECT n.nspname AS schema,c.relname AS table,a.attname AS column
          FROM pg_constraint fk JOIN pg_class c ON c.oid=fk.conrelid JOIN pg_namespace n ON n.oid=c.relnamespace
          JOIN pg_attribute a ON a.attrelid=fk.conrelid AND a.attnum=fk.conkey[1]
          WHERE fk.contype='f' AND fk.confrelid=to_regclass($1) AND cardinality(fk.conkey)=1`,
          [kind]
        );
        for (const ref of refs.rows) {
          const linked = await db.query(
            `SELECT 1 FROM ${quote(ref.schema)}.${quote(ref.table)} WHERE ${quote(ref.column)}=$1 LIMIT 1`,
            [id]
          );
          if (linked.rowCount)
            throw Error(
              'This entry has linked ' +
                String(ref.table).replace(/_/g, ' ') +
                '. Remove or reassign these links first.'
            );
        }
      }
      await db.query(
        `INSERT INTO admin_entry_history(entity_type,entity_id,operation,reason,snapshot,actor_id)
        VALUES($1,$2,$3,$4,$5::jsonb,$6)`,
        [kind, id, remove ? 'deleted' : 'updated', reason, JSON.stringify(snapshot), auth.user!.id]
      );
      if (remove) {
        await db.query(`DELETE FROM ${quote(kind)} WHERE id=$1`, [id]);
      } else {
        if (kind === 'service_visit_devices') {
          const status = String(fields.service_status || '');
          const valid = await db.query('SELECT name FROM service_status_options WHERE name=$1', [
            status
          ]);
          if (!valid.rowCount) throw Error('Choose a valid service status.');
        }
        const values = def.fields.map(f => {
          const raw = fields[f.name];
          if (typeof raw !== 'string') throw Error('Check ' + f.label + '.');
          const value = raw.trim();
          if (f.type === 'datetime-local') return value || null;
          if (f.type === 'number') {
            const number = Number(value);
            if (
              !value ||
              !Number.isSafeInteger(number) ||
              number < (f.min ?? 0) ||
              number > 2147483647
            )
              throw Error('Check ' + f.label + '.');
            return number;
          }
          if (
            (f.required && !value) ||
            value.length > (f.max || 10000) ||
            (f.options && !f.options.includes(value))
          )
            throw Error('Check ' + f.label + '.');
          if (f.type === 'date' && value) {
            const parsed = new Date(value + 'T00:00:00Z');
            if (
              !/^\d{4}-\d{2}-\d{2}$/.test(value) ||
              !Number.isFinite(parsed.getTime()) ||
              parsed.toISOString().slice(0, 10) !== value
            )
              throw Error('Check ' + f.label + '.');
          }
          if (f.type === 'time' && value && !/^([01]\d|2[0-3]):[0-5]\d(?::[0-5]\d)?$/.test(value))
            throw Error('Check ' + f.label + '.');
          return (f.type === 'date' || f.type === 'time') && !value ? null : value;
        });
        if (
          kind === 'repair_entries' &&
          fields.completed_date &&
          String(fields.completed_date) < String(fields.received_date)
        )
          throw Error('Completion cannot be before receipt.');
        if (kind === 'appointments' && String(fields.end_date) < String(fields.appointment_date))
          throw Error('End date cannot be before start date.');
        if (
          kind === 'contracts' &&
          fields.start_date &&
          fields.end_date &&
          String(fields.end_date) < String(fields.start_date)
        )
          throw Error('End date cannot be before start date.');
        if (kind === 'stock_movements')
          await adjustMovement(db, original, Number(fields.quantity) - Number(original.quantity));
        let extra = '';
        if (kind === 'dockets') {
          parseWorkTimes(fields.started_at, fields.ended_at, false);
        }
        if (kind === 'dockets') extra = ",correction_pending=true,signature_data=''";
        if (kind === 'service_visits') {
          await db.query('DELETE FROM service_visit_signatures WHERE service_visit_id=$1', [id]);
          extra = ",status='draft',finalized_at=NULL";
        }
        if (kind === 'devices') {
          const serial = String(fields.serial_number || '').trim(),
            asset = String(fields.asset_number || '').trim();
          if (!serial && !asset) throw Error('A serial or asset number is required.');
          values.push(serial ? 'serial:' + serial.toLowerCase() : 'asset:' + asset.toLowerCase());
          extra = ',identity_key=$' + (values.length + 1);
        }
        await db.query(
          `UPDATE ${quote(kind)} SET ${def.fields.map((f, i) => quote(f.name) + '=$' + (i + 2)).join(',')}${extra} WHERE id=$1`,
          [id, ...values]
        );
      }
      await writeAudit(db, auth.user!.id, remove ? 'deleted' : 'updated', kind, id, {
        reason,
        originalPreserved: true
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
export async function PATCH(request: Request) {
  return mutate(request, false);
}
export async function DELETE(request: Request) {
  return mutate(request, true);
}
