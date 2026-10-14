import { Pool } from 'pg';

const globalForDb = globalThis as unknown as { oxygenCarePool?: Pool };

export function getDb() {
  if (!process.env.DATABASE_URL) throw new Error('The database service is not configured. Contact your administrator.');
  if (!globalForDb.oxygenCarePool) {
    const databaseUrl = new URL(process.env.DATABASE_URL);
    const sslMode = process.env.DATABASE_SSL || (['localhost', '127.0.0.1', '::1', '[::1]'].includes(databaseUrl.hostname) ? 'disable' : 'verify-full');
    globalForDb.oxygenCarePool = new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: sslMode === 'disable' ? undefined : { rejectUnauthorized: sslMode !== 'require' },
      max: 10,
      connectionTimeoutMillis: 5000,
      idleTimeoutMillis: 30000,
    });
    globalForDb.oxygenCarePool.on('error', (error) => {
      console.error('Unexpected idle database connection error:', error.message);
    });
  }

  return globalForDb.oxygenCarePool;
}
