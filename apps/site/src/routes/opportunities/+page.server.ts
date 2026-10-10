import { error } from '@sveltejs/kit';
import { opportunitySearchRequest } from '$lib/opportunity-search-request.js';
import { loadAdminShellData } from '$lib/server/admin-shell-data';
import { getAppConfig } from '$lib/server/app-config';
import { searchPublicOpportunities } from '$lib/server/public-search/index.js';
import { preparePublicPage } from '$lib/server/public-search/page.js';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ url, locals, setHeaders }) => {
  await preparePublicPage(setHeaders);
  let parsed: ReturnType<typeof opportunitySearchRequest>;
  try {
    parsed = opportunitySearchRequest(url);
  } catch {
    error(400, 'Please shorten your search or check the selected filters.');
  }
  return {
    ...parsed,
    workspace:
      locals.user && locals.workspaceSubject
        ? await loadAdminShellData(locals)
        : null,
    appName: getAppConfig().appName,
    page: await searchPublicOpportunities(parsed.input),
    accountKey:
      locals.user && locals.workspaceSubject
        ? `${locals.workspaceSubject.tenantId}:${locals.workspaceSubject.userId}`
        : 'guest',
    signedIn: Boolean(locals.user && locals.workspaceSubject),
  };
};
