import { error } from '@sveltejs/kit';
import { buildAdminResourceShell } from '$lib/admin/resource-shell';
import type { PageLoad } from './$types';

// Universal load (#96): the list shell is static resource metadata plus the
// identity the admin layout already loaded, so an in-app click builds it in
// the browser instead of waiting on /__data.json. Records hydrate after mount
// through the authenticated list API; form actions stay in +page.server.ts.
export const load: PageLoad = async ({ params, parent, url }) => {
  const { tenantId, user } = await parent();
  const shell = buildAdminResourceShell(params.resource, url, {
    tenantId,
    user: user ? { id: user.id } : null,
  });
  if (!shell) error(404, `Unknown admin resource: ${params.resource}`);
  return shell;
};
