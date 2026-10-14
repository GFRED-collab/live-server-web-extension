import { NextResponse } from 'next/server';
import { getDb } from '../../../lib/db';

export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    await getDb().query('SELECT 1');
    return NextResponse.json({ ok: true, database: 'connected' });
  } catch {
    return NextResponse.json({ ok: false, database: 'unavailable' }, { status: 503 });
  }
}
