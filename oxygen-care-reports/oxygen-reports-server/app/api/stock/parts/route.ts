import { writeAudit } from '../../../../lib/audit';
import { requireUser } from '../../../../lib/auth';
import { getDb } from '../../../../lib/db';
import { errorResponse, jsonObject } from '../../../../lib/http';
export async function PUT(request: Request) {
  const auth = await requireUser(['super_user', 'warehouse_user']);
  if (auth.response) return auth.response;
  try {
    const body = await jsonObject(request),
      parts = Array.isArray(body.parts) ? body.parts : [],
      db = getDb();
    if (!parts.length || parts.length > 5000) throw Error('Import between 1 and 5,000 stock rows.');
    const seen = new Set<string>();
    for (const raw of parts) {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw))
        throw Error('Each stock row must be an object.');
      const item = raw as Record<string, unknown>,
        number = String(item.partNumber || '').trim(),
        name = String(item.name || '').trim(),
        quantity = Number(item.warehouseQuantity);
      if (
        !number ||
        !name ||
        number.length > 160 ||
        name.length > 300 ||
        item.warehouseQuantity == null ||
        item.warehouseQuantity === '' ||
        !Number.isSafeInteger(quantity) ||
        quantity < 0 ||
        quantity > 2147483647
      )
        throw Error('Each stock row needs a part number, name and non-negative whole quantity.');
      if (
        item.location !== undefined &&
        (typeof item.location !== 'string' || item.location.trim().length > 160)
      )
        throw Error('Location must be text up to 160 characters.');
      if (seen.has(number)) throw Error('Duplicate part numbers in import.');
      seen.add(number);
    }
    const client = await db.connect();
    try {
      await client.query('BEGIN');
      for (const raw of parts) {
        const item = raw as Record<string, unknown>,
          quantity = Number(item.warehouseQuantity);
        if (!String(item.partNumber || '').trim() || !Number.isInteger(quantity) || quantity < 0)
          throw Error('Each stock item requires a part number and non-negative whole quantity.');
        await client.query(
          `INSERT INTO spare_parts(part_number,name,warehouse_quantity,location) VALUES($1,$2,$3,COALESCE($4,'')) ON CONFLICT(part_number) DO UPDATE SET name=EXCLUDED.name,warehouse_quantity=EXCLUDED.warehouse_quantity,location=COALESCE($4,spare_parts.location)`,
          [
            String(item.partNumber).trim(),
            String(item.name || '').trim(),
            quantity,
            item.location === undefined ? null : String(item.location).trim()
          ]
        );
      }
      await writeAudit(client, auth.user!.id, 'uploaded', 'stock_import', null, {
        count: parts.length
      });
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
