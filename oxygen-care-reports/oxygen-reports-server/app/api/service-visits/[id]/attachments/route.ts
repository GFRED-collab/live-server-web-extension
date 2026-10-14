import { requireUser } from '../../../../../lib/auth';
import { getDb } from '../../../../../lib/db';
import { errorResponse, jsonObject } from '../../../../../lib/http';
import { writeAudit } from '../../../../../lib/audit';
import { decodeServiceAttachment } from '../../../../../lib/service-attachment';
import type { PoolClient } from 'pg';
type Context = { params: Promise<{ id: string }> };
const uuid = (value: string) => /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(value);
async function access(
  db: PoolClient,
  id: string,
  deviceId: string,
  user: { id: string; role: string },
  lock = false
) {
  if (!uuid(id) || !uuid(deviceId)) throw Error('Choose a valid visit and device.');
  const result = await db.query(
    `SELECT sv.status FROM service_visits sv JOIN contracts ct ON ct.id=sv.contract_id
 JOIN contract_devices cd ON cd.contract_id=ct.id AND cd.device_id=$4 JOIN devices d ON d.id=cd.device_id AND d.client_id=ct.client_id
 WHERE sv.id=$1 AND cd.added_on<=sv.service_date AND (cd.removed_on IS NULL OR cd.removed_on>=sv.service_date)
 AND ($2='super_user' OR EXISTS(SELECT 1 FROM contract_assignments ca WHERE ca.contract_id=ct.id AND ca.user_id=$3))${lock ? ' FOR UPDATE OF sv' : ''}`,
    [id, user.role, user.id, deviceId]
  );
  return result.rows[0];
}
export async function GET(request: Request, { params }: Context) {
  const auth = await requireUser();
  if (auth.response) return auth.response;
  try {
    const { id } = await params,
      url = new URL(request.url),
      deviceId = url.searchParams.get('deviceId') || '',
      fileId = url.searchParams.get('file') || '';
    if (fileId && !uuid(fileId)) throw Error('Choose a valid attachment.');
    const db = await getDb().connect();
    try {
      if (!(await access(db, id, deviceId, auth.user!)))
        return Response.json({ error: 'Visit or device not found.' }, { status: 404 });
      if (fileId) {
        const result = await db.query(
          'SELECT filename,content_type,content FROM service_attachments WHERE id=$1 AND service_visit_id=$2 AND device_id=$3 AND removed_at IS NULL',
          [fileId, id, deviceId]
        );
        if (!result.rowCount)
          return Response.json({ error: 'Attachment not found.' }, { status: 404 });
        const file = result.rows[0];
        return new Response(new Uint8Array(file.content), {
          headers: {
            'Content-Type': file.content_type,
            'Content-Disposition':
              'attachment; filename="attachment"; filename*=UTF-8\'\'' +
              encodeURIComponent(file.filename),
            'Cache-Control': 'no-store',
            'X-Content-Type-Options': 'nosniff',
            'Content-Security-Policy': "sandbox; default-src 'none'"
          }
        });
      }
      const result = await db.query(
        'SELECT id,filename,content_type AS "contentType",octet_length(content) AS size,uploaded_at AS "uploadedAt" FROM service_attachments WHERE service_visit_id=$1 AND device_id=$2 AND removed_at IS NULL ORDER BY uploaded_at DESC',
        [id, deviceId]
      );
      return Response.json({ attachments: result.rows });
    } finally {
      db.release();
    }
  } catch (error) {
    return errorResponse(error);
  }
}
async function mutate(request: Request, { params }: Context, remove: boolean) {
  const auth = await requireUser();
  if (auth.response) return auth.response;
  try {
    const { id } = await params,
      body = await jsonObject(request),
      deviceId = String(body.deviceId || ''),
      fileId = String(body.fileId || '');
    if (remove && !uuid(fileId)) throw Error('Choose a valid attachment.');
    const file = remove ? null : decodeServiceAttachment(body),
      db = await getDb().connect();
    try {
      await db.query('BEGIN');
      const visit = await access(db, id, deviceId, auth.user!, true);
      if (!visit) {
        await db.query('ROLLBACK');
        return Response.json({ error: 'Visit or device not found.' }, { status: 404 });
      }
      if (visit.status !== 'draft') throw Error('Finalized service visits are read-only.');
      let attachmentId = fileId,
        filename = '';
      if (remove) {
        const result = await db.query(
          'UPDATE service_attachments SET removed_at=now(),removed_by=$4 WHERE id=$1 AND service_visit_id=$2 AND device_id=$3 AND removed_at IS NULL RETURNING filename',
          [fileId, id, deviceId, auth.user!.id]
        );
        if (!result.rowCount) throw Error('Attachment not found.');
        filename = result.rows[0].filename;
      } else if (file) {
        const quota = await db.query(
          'SELECT count(*)::int AS count,COALESCE(sum(octet_length(content)),0)::bigint AS size FROM service_attachments WHERE service_visit_id=$1 AND device_id=$2',
          [id, deviceId]
        );
        if (
          Number(quota.rows[0].count) >= 20 ||
          Number(quota.rows[0].size) + file.content.length > 50 * 1024 * 1024
        )
          throw Error(
            'Attachment storage limit reached for this device and visit (20 files / 50 MB, including retained originals).'
          );
        const result = await db.query(
          'INSERT INTO service_attachments(service_visit_id,device_id,filename,content_type,content,uploaded_by) VALUES($1,$2,$3,$4,$5,$6) RETURNING id',
          [id, deviceId, file.filename, file.contentType, file.content, auth.user!.id]
        );
        attachmentId = result.rows[0].id;
        filename = file.filename;
      }
      await writeAudit(
        db,
        auth.user!.id,
        remove ? 'deleted' : 'uploaded',
        'service_attachment',
        attachmentId,
        { serviceVisitId: id, deviceId, filename }
      );
      await db.query('COMMIT');
      return Response.json({ id: attachmentId }, { status: remove ? 200 : 201 });
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
export const POST = (request: Request, context: Context) => mutate(request, context, false);
export const DELETE = (request: Request, context: Context) => mutate(request, context, true);
