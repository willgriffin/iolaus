import { error } from '@sveltejs/kit';
import { isSharedHosted } from '$lib/server/app-config.js';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals, setHeaders }) => {
  setHeaders({ 'cache-control': 'private, no-store' });
  if (!isSharedHosted() || process.env.IOLAUS_PUBLIC_SEARCH_ENABLED !== 'true')
    error(404, 'Public catalog is not enabled.');
  // Saved browser history stays readable even when the live catalog is down.
  return {
    accountKey:
      locals.user && locals.workspaceSubject
        ? `${locals.workspaceSubject.tenantId}:${locals.workspaceSubject.userId}`
        : 'guest',
    signedIn: Boolean(locals.user && locals.workspaceSubject),
  };
};
