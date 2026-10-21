import { listPublicSitemapEntries } from '$lib/server/public-search/index.js';
import { preparePublicPage } from '$lib/server/public-search/page.js';
import type { RequestHandler } from './$types';

const escapeXml = (value: string) =>
  value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
export const GET: RequestHandler = async ({ url, setHeaders }) => {
  await preparePublicPage(setHeaders, 10);
  const rows = await listPublicSitemapEntries();
  const paths = new Map<string, string | null>([
    ['/', null],
    ['/opportunities', null],
  ]);
  for (const row of rows) {
    paths.set(`/opportunities/${encodeURIComponent(row.id)}`, row.updated_at);
    if (row.company_id)
      paths.set(`/companies/${encodeURIComponent(row.company_id)}`, null);
    for (const skill of row.skills)
      paths.set(`/skills/${encodeURIComponent(skill)}`, null);
  }
  const xml = `<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${[
    ...paths,
  ]
    .slice(0, 50000)
    .map(
      ([path, modified]) =>
        `<url><loc>${escapeXml(url.origin + path)}</loc>${modified ? `<lastmod>${modified}</lastmod>` : ''}</url>`,
    )
    .join('')}</urlset>`;
  return new Response(xml, {
    headers: {
      'content-type': 'application/xml; charset=utf-8',
      'cache-control': 'public, max-age=0, must-revalidate',
    },
  });
};
