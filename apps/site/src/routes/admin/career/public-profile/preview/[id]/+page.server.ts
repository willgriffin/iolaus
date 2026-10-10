import { error } from '@sveltejs/kit';
import { getPublicProfilePreview } from '$lib/server/public-profile-service';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals, params, setHeaders }) => {
  setHeaders({ 'cache-control': 'private, no-store' });
  const preview = await getPublicProfilePreview(locals, params.id);
  if (!preview) error(404, 'Not found');
  return preview;
};
