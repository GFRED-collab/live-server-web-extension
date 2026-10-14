import bcrypt from 'bcryptjs';
import pg from 'pg';

const args = process.argv.slice(2);
const valueFor = (name) => { const index = args.indexOf(name); return index < 0 ? undefined : args[index + 1]; };
const email = valueFor('--email');
const password = valueFor('--password');

if (!process.env.DATABASE_URL || !email || !password || password.length < 12 || Buffer.byteLength(password, 'utf8') > 72) {
  console.error('Usage: DATABASE_URL=... npm run db:bootstrap-super-user -- --email admin@example.com --password "12-or-more-characters" (maximum 72 UTF-8 bytes)');
  process.exit(1);
}

const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
await client.connect();
try {
  const passwordHash = await bcrypt.hash(password, 12);
  await client.query(
    `INSERT INTO users (email, display_name, role, password_hash, active)
     VALUES ($1, $2, 'super_user', $3, true)
     ON CONFLICT (email) DO UPDATE SET role = 'super_user', password_hash = EXCLUDED.password_hash, active = true, updated_at = now()`,
    [email.toLowerCase(), email.split('@')[0], passwordHash],
  );
  console.log(`Super User ready: ${email.toLowerCase()}`);
} finally {
  await client.end();
}
