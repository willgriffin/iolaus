import { isSharedHosted } from '$lib/server/app-config.js';
import type { RequestHandler } from './$types';
export const GET: RequestHandler = ({ url }) =>
  !isSharedHosted() || process.env.IOLAUS_PUBLIC_SEARCH_ENABLED !== 'true'
    ? new Response('Not found', {
        status: 404,
        headers: { 'cache-control': 'no-store' },
      })
    : new Response(
        `User-agent: *\nAllow: /opportunities\nAllow: /companies\nAllow: /skills\nDisallow: /admin\nDisallow: /api\nSitemap: ${url.origin}/sitemap.xml\n`,
        {
          headers: {
            'content-type': 'text/plain; charset=utf-8',
            'cache-control': 'public, max-age=0, must-revalidate',
          },
        },
      );
