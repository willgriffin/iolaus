import { publicSearchInputSchema } from '$lib/public-opportunity-contract.js';
import { searchPublicOpportunities } from '$lib/server/public-search/index.js';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ url, setHeaders }) => {
  setHeaders({
    'cache-control': 'public, max-age=0, s-maxage=60, must-revalidate',
  });
  const input = publicSearchInputSchema.parse(
    Object.fromEntries(url.searchParams),
  );
  return { input, page: await searchPublicOpportunities(input) };
};
