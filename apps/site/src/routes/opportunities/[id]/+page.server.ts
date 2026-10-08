import { error } from '@sveltejs/kit';
import { publicJobPosting } from '$lib/public-job-posting.js';
import { getPublicOpportunity } from '$lib/server/public-search/index.js';
import { preparePublicPage } from '$lib/server/public-search/page.js';
import type { PageServerLoad } from './$types';
export const load: PageServerLoad = async ({ params, setHeaders, url }) => {
  await preparePublicPage(setHeaders);
  const opportunity = await getPublicOpportunity(params.id);
  if (!opportunity) error(404, 'Not found');
  return {
    opportunity,
    structuredData: publicJobPosting(opportunity, url.origin),
  };
};
