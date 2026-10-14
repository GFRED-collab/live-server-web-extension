import { readdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required.');
const directory = join(dirname(fileURLToPath(import.meta.url)), '..', 'database', 'migrations');
const client = new pg.Client({ connectionString: process.env.DATABASE_URL, ssl: process.env.DATABASE_SSL === 'disable' ? undefined : { rejectUnauthorized: true } });
await client.connect();
try {
  await client.query('CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())');
  for (const name of (await readdir(directory)).filter((entry) => entry.endsWith('.sql')).sort()) {
    if ((await client.query('SELECT 1 FROM schema_migrations WHERE name=$1', [name])).rowCount) continue;
    await client.query('BEGIN');
    try {
      await client.query(await readFile(join(directory, name), 'utf8'));
      await client.query('INSERT INTO schema_migrations(name) VALUES($1)', [name]);
      await client.query('COMMIT');
      console.log(`Applied migration ${name}`);
    } catch (error) { await client.query('ROLLBACK'); throw error; }
  }
} finally { await client.end(); }
