import { error } from '@sveltejs/kit';
import { isSharedHosted } from '$lib/server/app-config';
import { getPublicProfile } from '$lib/server/public-profile-service';
import type { PageServerLoad } from './$types';

function publicProfilesEnabled(): boolean {
  return (
    isSharedHosted() && process.env.IOLAUS_PUBLIC_PROFILES_ENABLED === 'true'
  );
}

export const load: PageServerLoad = async ({ locals, params, setHeaders }) => {
  setHeaders({
    'cache-control': 'no-store',
    'x-robots-tag': 'noindex, nofollow',
  });

  if (!publicProfilesEnabled()) error(404, 'Not found');

  const profile = await getPublicProfile(params.handle);
  if (!profile) error(404, 'Not found');
  return {
    ...profile,
    signedIn: Boolean(locals.user && locals.workspaceSubject),
  };
};
