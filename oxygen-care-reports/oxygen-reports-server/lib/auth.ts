import { createHash, randomBytes } from 'node:crypto';
import { cookies } from 'next/headers';
import { getDb } from './db';

export const SESSION_COOKIE = 'oxygen_reports_session';
const sessionHours = 8;

export type SessionUser = {
  id: string;
  email: string;
  displayName: string;
  role: 'super_user' | 'department_head' | 'department_user' | 'engineer' | 'warehouse_user' | 'customer';
  departmentId: string | null;
  departmentName: string | null;
  canExport: boolean;
  sessionRemainingMs: number;
};

const tokenHash = (token: string) => createHash('sha256').update(token).digest('hex');

export async function createSession(userId: string) {
  const jar = await cookies();
  const previous = jar.get(SESSION_COOKIE)?.value;
  const token = randomBytes(32).toString('base64url');
  const expiresAt = new Date(Date.now() + sessionHours * 60 * 60 * 1000);
  await getDb().query(
    `INSERT INTO sessions (user_id, token_hash, expires_at) VALUES ($1, $2, $3)`,
    [userId, tokenHash(token), expiresAt],
  );
  if(previous && /^[A-Za-z0-9_-]{43}$/.test(previous)) await getDb().query('DELETE FROM sessions WHERE token_hash = $1',[tokenHash(previous)]);
  jar.set(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: 'strict',
    secure: process.env.NODE_ENV === 'production',
    path: '/',
    expires: expiresAt,
  });
}

export async function deleteSession() {
  const jar = await cookies();
  const token = jar.get(SESSION_COOKIE)?.value;
  if (token) await getDb().query('DELETE FROM sessions WHERE token_hash = $1', [tokenHash(token)]);
  jar.delete(SESSION_COOKIE);
}

export async function currentUser(): Promise<SessionUser | null> {
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  if (!token || !/^[A-Za-z0-9_-]{43}$/.test(token)) return null;
  const result = await getDb().query(
    `SELECT u.id, u.email::text, u.display_name, u.role, u.department_id, d.name AS department_name, u.can_export,
            s.id AS session_id, s.last_seen_at,
            EXTRACT(EPOCH FROM (LEAST(s.last_seen_at + interval '15 minutes',s.expires_at,s.created_at + interval '8 hours') - now())) * 1000 AS remaining_ms
       FROM sessions s
       JOIN users u ON u.id = s.user_id AND u.active = true
       LEFT JOIN departments d ON d.id = u.department_id
      WHERE s.token_hash = $1 AND s.expires_at > now()
        AND s.last_seen_at > now() - interval '15 minutes'
        AND s.created_at > now() - interval '8 hours'`,
    [tokenHash(token)],
  );
  const row = result.rows[0];
  if (!row) return null;
  return { id: row.id, email: row.email, displayName: row.display_name, role: row.role, departmentId: row.department_id, departmentName: row.department_name, canExport: row.can_export,sessionRemainingMs:Number(row.remaining_ms) };
}

/** Only explicit user-activity requests renew idle time; ordinary API reads never do. */
export async function recordSessionActivity(): Promise<number | null> {
  const token=(await cookies()).get(SESSION_COOKIE)?.value;
  if(!token||!/^[A-Za-z0-9_-]{43}$/.test(token))return null;
  const result=await getDb().query(`UPDATE sessions s SET last_seen_at=now()
    WHERE s.token_hash=$1 AND s.expires_at>now()
      AND s.last_seen_at>now()-interval '15 minutes' AND s.created_at>now()-interval '8 hours'
      AND EXISTS(SELECT 1 FROM users u WHERE u.id=s.user_id AND u.active=true)
    RETURNING EXTRACT(EPOCH FROM (LEAST(now()+interval '15 minutes',s.expires_at,s.created_at+interval '8 hours')-now()))*1000 AS remaining_ms`,[tokenHash(token)]);
  return result.rows.length?Number(result.rows[0].remaining_ms):null;
}

export async function requireUser(roles?: SessionUser['role'][]) {
  const user = await currentUser();
  if (!user) return { user: null, response: Response.json({ error: 'Authentication required.' }, { status: 401 }) };
  // Customer access is opt-in. Existing staff APIs must never inherit it.
  if (user.role === 'customer' && !roles?.includes('customer')) return { user: null, response: Response.json({ error: 'Customer accounts cannot access staff tools.' }, { status: 403 }) };
  if (roles && !roles.includes(user.role)) return { user: null, response: Response.json({ error: 'You do not have permission to do that.' }, { status: 403 }) };
  return { user, response: null };
}
