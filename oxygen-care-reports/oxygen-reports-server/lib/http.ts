import { rejectEmojiText } from './emoji-validation';

export async function jsonObject(request: Request) {
  const reader = request.body?.getReader();
  if (!reader) throw new Error('A JSON object is required.');
  const chunks: Buffer[] = [];
  let size = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > 8 * 1024 * 1024) {
        await reader.cancel();
        throw new PayloadTooLarge();
      }
      chunks.push(Buffer.from(chunk.value));
    }
  } finally {
    reader.releaseLock();
  }
  let value: unknown;
  try {
    value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new Error('A valid JSON object is required.');
  }
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('A JSON object is required.');
  const pathname = new URL(request.url).pathname;
  // Legacy clients sent the entire original record when deleting an entry.
  // These fields are not written: discard them before text validation so old
  // emoji entries can be removed. IDs, version and the new audit reason remain validated.
  if (request.method === 'DELETE' && pathname === '/api/admin/entries') {
    delete (value as Record<string, unknown>).fields;
  }
  const credentials =
    pathname === '/api/auth/login' ||
    pathname === '/api/customer-accounts' ||
    pathname === '/api/users' ||
    /^\/api\/users\/[^/]+$/.test(pathname);
  rejectEmojiText(value as Record<string, unknown>, credentials);
  return value as Record<string, unknown>;
}

class PayloadTooLarge extends Error {}

export function errorResponse(error: unknown) {
  if (error instanceof PayloadTooLarge)
    return Response.json({ error: 'The request is too large.' }, { status: 413 });
  if (
    error instanceof TypeError ||
    error instanceof ReferenceError ||
    error instanceof SyntaxError
  ) {
    console.error('Request failed:', error.name);
    return Response.json({ error: 'The request could not be completed.' }, { status: 500 });
  }
  const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : '';
  if (code === '23505')
    return Response.json(
      { error: 'An entry with that identifier already exists.' },
      { status: 409 }
    );
  if (code === '23503')
    return Response.json(
      { error: 'The selected record no longer exists or is still in use. Refresh and try again.' },
      { status: 409 }
    );
  if (code === '22P02' || code === '22007' || code === '22008' || code === '23514')
    return Response.json(
      { error: 'Check the supplied values, identifiers and dates.' },
      { status: 400 }
    );
  if (code)
    return Response.json(
      { error: 'The database request could not be completed. Please try again.' },
      { status: 503 }
    );
  const message = error instanceof Error ? error.message : 'Request failed.';
  return Response.json({ error: message }, { status: 400 });
}
