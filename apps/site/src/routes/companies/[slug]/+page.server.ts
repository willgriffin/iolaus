import { error } from '@sveltejs/kit';
import { searchPublicOpportunities } from '$lib/server/public-search/index.js';
import { preparePublicPage } from '$lib/server/public-search/page.js';
import type { PageServerLoad } from './$types';
export const load: PageServerLoad = async ({ params, setHeaders }) => {
  await preparePublicPage(setHeaders);
  const page = await searchPublicOpportunities({
    q: '',
    company: params.slug,
    skills: [],
    seniority: [],
    function: [],
    work_mode: [],
    employment_type: [],
    country: [],
    limit: 50,
    sort: 'newest',
  });
  if (!page.items.length) error(404, 'Not found');
  return { page, company: page.items[0].company };
};
