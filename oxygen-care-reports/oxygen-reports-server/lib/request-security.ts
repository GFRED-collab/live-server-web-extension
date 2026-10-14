export const MAX_JSON_BYTES = 8 * 1024 * 1024;

export function mutationError(request: Request, configuredOrigin?: string): string | null {
  if (['GET', 'HEAD', 'OPTIONS'].includes(request.method)) return null;
  if (request.headers.get('sec-fetch-site') === 'cross-site') return 'Cross-site requests are not allowed.';
  const origin = request.headers.get('origin');
  try {
    const expected = new URL(configuredOrigin || request.url).origin;
    if (!origin || new URL(origin).origin !== expected || origin === 'null') return 'A same-origin request is required.';
  } catch { return 'A same-origin request is required.'; }
  if (!/^application\/json(?:\s*;|$)/i.test(request.headers.get('content-type') || '')) return 'Use application/json for API changes.';
  const length = request.headers.get('content-length');
  if (length && (!/^\d+$/.test(length) || Number(length) > MAX_JSON_BYTES)) return 'The request is too large.';
  return null;
}
