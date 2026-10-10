import { isSharedHosted } from '$lib/server/app-config.js';
import type { RequestHandler } from './$types';
export const GET: RequestHandler = ({ url }) =>
  !isSharedHosted() || process.env.IOLAUS_PUBLIC_SEARCH_ENABLED !== 'true'
    ? new Response('Not found', {
        status: 404,
        headers: { 'cache-control': 'no-store' },
      })
    : new Response(
        `<?xml version="1.0" encoding="UTF-8"?><OpenSearchDescription xmlns="http://a9.com/-/spec/opensearch/1.1/"><ShortName>Iolaus opportunities</ShortName><Description>Search public opportunities</Description><Url type="text/html" template="${url.origin}/opportunities?q={searchTerms}"/></OpenSearchDescription>`,
        {
          headers: {
            'content-type':
              'application/opensearchdescription+xml; charset=utf-8',
            'cache-control': 'public, max-age=0, must-revalidate',
          },
        },
      );
