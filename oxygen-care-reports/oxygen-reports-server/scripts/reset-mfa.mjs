import pg from 'pg';

// Server-side emergency reset, for when no other Super User can reset an authenticator.
// Usage (on the server): sudo -u oxygen-care-reports env $(sudo cat /etc/oxygen-care-reports/oxygen-care-reports.env | xargs) \
//   node scripts/reset-mfa.mjs --email person@example.com
const index = process.argv.indexOf('--email');
const email = index < 0 ? '' : String(process.argv[index + 1] || '').toLowerCase();
if (!process.env.DATABASE_URL || !email) {
  console.error('Usage: DATABASE_URL=... node scripts/reset-mfa.mjs --email person@example.com');
  process.exit(1);
}
const client = new pg.Client({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_SSL === 'disable' ? undefined : { rejectUnauthorized: true }
});
await client.connect();
try {
  await client.query('BEGIN');
  const result = await client.query(
    `UPDATE users SET mfa_secret_encrypted=NULL, mfa_enabled_at=NULL, mfa_last_step=NULL,
       mfa_recovery_hashes='{}' WHERE email=$1 AND role::text<>'customer' RETURNING id`,
    [email]
  );
  if (!result.rowCount) throw new Error(`No staff account with email ${email}.`);
  const id = result.rows[0].id;
  await client.query('DELETE FROM sessions WHERE user_id=$1', [id]);
  await client.query('DELETE FROM login_challenges WHERE user_id=$1', [id]);
  await client.query(
    `INSERT INTO activity_log (actor_id, kind, entity_type, entity_id, detail)
     VALUES (NULL, 'updated', 'user', $1, $2)`,
    [id, JSON.stringify({ authenticator: 'reset from server' })]
  );
  await client.query('COMMIT');
  console.log(
    `Authenticator reset for ${email}. They will set up a new one at their next sign-in.`
  );
} catch (error) {
  await client.query('ROLLBACK');
  console.error(error.message);
  process.exitCode = 1;
} finally {
  await client.end();
}
