import { NextRequest, NextResponse } from 'next/server';
import { mutationError } from './lib/request-security';

export function proxy(request: NextRequest) {
  const error = mutationError(request, process.env.APP_URL);
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
