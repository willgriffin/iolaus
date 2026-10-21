import { error, fail, redirect } from '@sveltejs/kit';
import { getLocalOAuth } from '$lib/server/local-oauth';
import type { Actions, PageServerLoad } from './$types';
export const load: PageServerLoad = async (event) => {
  event.setHeaders({ 'cache-control': 'private, no-store' });
  if (!event.locals.user || !event.locals.sessionId)
    redirect(303, '/login?next=%2Faccount%2Fconnections');
  const oauth = await getLocalOAuth();
  if (!oauth) error(404, 'Not found');
  return {
    grants: await oauth.authorization.listGrants(event.locals.sessionId),
  };
};
export const actions: Actions = {
  revoke: async (event) => {
    event.setHeaders({ 'cache-control': 'private, no-store' });
    if (event.request.headers.get('origin') !== event.url.origin)
      error(403, 'Invalid request origin.');
    if (!event.locals.user || !event.locals.sessionId)
      error(401, 'Sign in required.');
    const oauth = await getLocalOAuth();
    if (!oauth) error(404, 'Not found');
    const grantId = String(
      (await event.request.formData()).get('grantId') ?? '',
    );
    if (
      !grantId ||
      !(await oauth.authorization.revokeGrant(event.locals.sessionId, grantId))
    )
      return fail(404, { missing: true });
    return { revoked: true };
  },
};
