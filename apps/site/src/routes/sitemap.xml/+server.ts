import { searchPublicOpportunities } from '$lib/server/public-search/index.js';
import type { RequestHandler } from './$types';
export const GET: RequestHandler = async ({ url }) => {
  const page = await searchPublicOpportunities({
    q: '',
    skills: [],
    seniority: [],
    function: [],
    workMode: [],
    employmentType: [],
    country: [],
    limit: 50,
    sort: 'newest',
  });
  const origin = url.origin;
  const paths = [
    '/opportunities',
    ...page.items.map(
      (item) => `/opportunities/${encodeURIComponent(item.id)}`,
    ),
  ];
  const xml = `<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${paths.map((path) => `<url><loc>${origin}${path}</loc></url>`).join('')}</urlset>`;
  return new Response(xml, {
    headers: {
      'content-type': 'application/xml; charset=utf-8',
      'cache-control': 'public, max-age=0, s-maxage=300',
    },
  });
};
