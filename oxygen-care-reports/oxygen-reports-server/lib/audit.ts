import type { Pool, PoolClient } from 'pg';

export type AuditKind = 'created' | 'updated' | 'deleted' | 'uploaded' | 'exported' | 'assigned' | 'fitted' | 'signed_in' | 'password_reset';

export async function writeAudit(
  db: Pool | PoolClient,
  actorId: string | null,
  kind: AuditKind,
  entityType: string,
  entityId: string | null,
  detail: Record<string, unknown> = {},
) {
  await db.query(
    `INSERT INTO activity_log (actor_id, kind, entity_type, entity_id, detail)
     VALUES ($1, $2, $3, $4, $5::jsonb)`,
    [actorId, kind, entityType, entityId, JSON.stringify(detail)],
  );
}
