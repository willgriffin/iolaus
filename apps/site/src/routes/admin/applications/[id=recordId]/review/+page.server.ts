import { redirect } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';

// The review surface is now the application's canonical view at
// /admin/applications/[id]. Preserve old links/bookmarks.
export const load: PageServerLoad = ({ params }) => {
  redirect(308, `/admin/applications/${params.id}`);
};
