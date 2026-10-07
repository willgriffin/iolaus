import { error } from '@sveltejs/kit';
import { getPublicOpportunity } from '$lib/server/public-search/index.js';
import type { PageServerLoad } from './$types';
export const load: PageServerLoad = async ({ params, setHeaders }) => {
  setHeaders({
    'cache-control': 'public, max-age=0, s-maxage=60, must-revalidate',
  });
  const opportunity = await getPublicOpportunity(params.id);
  if (!opportunity) error(404, 'Not found');
  return { opportunity };
};
