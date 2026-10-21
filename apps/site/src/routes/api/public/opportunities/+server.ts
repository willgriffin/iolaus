import { json } from '@sveltejs/kit';
import { publicSearchInputSchema } from '$lib/public-opportunity-contract.js';
import { searchPublicOpportunities } from '$lib/server/public-search/index.js';
import type { RequestHandler } from './$types';

const CACHE = { 'cache-control': 'public, max-age=0, s-maxage=60, must-revalidate' };

export const GET: RequestHandler = async ({ url }) => {
  const parsed = publicSearchInputSchema.safeParse(Object.fromEntries(url.searchParams));
  if (!parsed.success) return json({ error: 'Invalid public search input.' }, { status: 400, headers: CACHE });
  try { return json(await searchPublicOpportunities(parsed.data), { headers: CACHE }); }
  catch { return json({ error: 'Public search is temporarily unavailable.' }, { status: 503, headers: CACHE }); }
};
