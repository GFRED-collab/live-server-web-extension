import { NextRequest, NextResponse } from 'next/server';
import { mutationError } from './lib/request-security';

export function proxy(request: NextRequest) {
  // APP_URL is the main address; APP_EXTRA_ORIGINS adds others, such as the public domain
  // alongside the Tailscale address.
  const origins = [process.env.APP_URL, ...(process.env.APP_EXTRA_ORIGINS || '').split(',')]
    .map(value => value?.trim() || '')
    .filter(Boolean);
  const error = mutationError(request, origins);
  const response = error
    ? NextResponse.json(
        { error },
        { status: error.includes('too large') ? 413 : error.startsWith('Use ') ? 415 : 403 }
      )
    : NextResponse.next();
  response.headers.set('Cache-Control', 'no-store, max-age=0');
  response.headers.set('Pragma', 'no-cache');
  response.headers.set('Vary', 'Origin, Sec-Fetch-Site');
  return response;
}

export const config = { matcher: '/api/:path*' };
