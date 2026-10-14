import { requireUser } from '../../../lib/auth';
import { getDb } from '../../../lib/db';
export async function GET(request: Request) {
  const auth = await requireUser(['super_user']);
  if (auth.response) return auth.response;
  const url = new URL(request.url),
    limit = Math.min(500, Math.max(1, Number(url.searchParams.get('limit')) || 100));
  const result = await getDb().query(
    `SELECT a.id,a.kind,a.entity_type AS "entityType",a.entity_id AS "entityId",a.detail,a.created_at AS "createdAt",u.display_name AS "actorName" FROM activity_log a LEFT JOIN users u ON u.id=a.actor_id ORDER BY a.created_at DESC LIMIT $1`,
    [limit]
  );
  return Response.json({ activity: result.rows });
}
