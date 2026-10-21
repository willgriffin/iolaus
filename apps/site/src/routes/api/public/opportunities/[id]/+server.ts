import { json } from '@sveltejs/kit';
import { getPublicOpportunity } from '$lib/server/public-search/index.js';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async ({ params }) => {
  try {
    const opportunity = await getPublicOpportunity(params.id);
    return opportunity ? json(opportunity, { headers: { 'cache-control': 'public, max-age=0, s-maxage=60, must-revalidate' } }) : json({ error: 'Not found' }, { status: 404 });
  } catch { return json({ error: 'Public opportunity is temporarily unavailable.' }, { status: 503 }); }
};
