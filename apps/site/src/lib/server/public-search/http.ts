import { createHash } from 'node:crypto';
import { ZodError } from 'zod';
import { isSharedHosted } from '../app-config.js';
import { consumePublicSearchBudget, PublicSearchError } from './index.js';

const listKeys = new Set([
  'skills',
  'seniority',
  'function',
  'work_mode',
  'employment_type',
  'country',
]);
export function publicSearchParameters(url: URL) {
  const data: Record<string, unknown> = {};
  for (const [key, value] of url.searchParams) {
    if (listKeys.has(key))
      data[key] = [
        ...((data[key] as string[]) ?? []),
        ...value.split(',').filter(Boolean),
      ];
    else if (key === 'remote_ok') {
      if (!['true', 'false'].includes(value))
        throw new PublicSearchError(400, 'remote_ok must be true or false');
      data[key] = value === 'true';
    } else if (key in data)
      throw new PublicSearchError(400, 'Duplicate query parameter');
    else data[key] = value;
  }
  return data;
}
let window = 0,
  requests = 0;
export async function publicResponse(
  request: Request,
  cost: number,
  produce: () => Promise<unknown> | unknown,
  cache = true,
) {
  try {
    if (
      !isSharedHosted() ||
      process.env.IOLAUS_PUBLIC_SEARCH_ENABLED !== 'true'
    )
      throw new PublicSearchError(404, 'Public catalog is not enabled.');
    const now = Math.floor(Date.now() / 60000);
    if (now !== window) {
      window = now;
      requests = 0;
    }
    if (++requests > 60)
      throw new PublicSearchError(429, 'Public request limit exceeded.');
    const remaining = await consumePublicSearchBudget(cost);
    const body = JSON.stringify(await produce());
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'Cache-Control': cache
        ? 'public, max-age=0, must-revalidate'
        : 'no-store',
      'X-RateLimit-Limit': '600',
      'X-RateLimit-Remaining': String(remaining),
      'X-RateLimit-Reset': String((now + 1) * 60),
      'X-Content-Type-Options': 'nosniff',
    };
    if (cache) {
      headers.ETag = `"${createHash('sha256').update(body).digest('hex')}"`;
      if (request.headers.get('if-none-match') === headers.ETag)
        return new Response(null, { status: 304, headers });
    }
    return new Response(body, { headers });
  } catch (error) {
    const status =
      error instanceof PublicSearchError
        ? error.status
        : error instanceof ZodError
          ? 400
          : 503;
    return new Response(
      JSON.stringify({
        type: 'about:blank',
        title:
          status === 400
            ? 'Invalid request'
            : status === 404
              ? 'Not found'
              : status === 429
                ? 'Too many requests'
                : 'Public catalog unavailable',
        status,
        detail:
          error instanceof PublicSearchError
            ? error.message
            : status === 400
              ? 'Input failed validation.'
              : 'Please retry later.',
      }),
      {
        status,
        headers: {
          'Content-Type': 'application/problem+json',
          'Cache-Control': 'no-store',
          ...(status === 429 ? { 'Retry-After': '60' } : {}),
        },
      },
    );
  }
}
