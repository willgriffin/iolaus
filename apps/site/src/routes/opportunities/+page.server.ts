import { publicSearchInputSchema } from '$lib/public-opportunity-contract.js';
import { publicSearchParameters } from '$lib/server/public-search/http.js';
import { searchPublicOpportunities } from '$lib/server/public-search/index.js';
import { preparePublicPage } from '$lib/server/public-search/page.js';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ url, setHeaders }) => {
  await preparePublicPage(setHeaders);
  const input = publicSearchInputSchema.parse(publicSearchParameters(url));
  return { input, page: await searchPublicOpportunities(input) };
};
