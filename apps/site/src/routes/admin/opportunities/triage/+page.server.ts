import { redirect } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';

/**
 * The retired standalone triage route (issue #425).
 *
 * The deck is now a modal over `/admin/opportunities`: the list is the context
 * and owns the filter, and a viewport-fixed action bar of our own fought the
 * admin shell's nav and dock. This route stays as a redirect so bookmarks, the
 * agent docs, and anything else pointing at the old URL keep working — the
 * filter parameters ride along untouched, and `?triage=1` opens the list with
 * the deck already up.
 *
 * `offset` was the standalone view's own skip cursor. A session starts fresh,
 * so it is dropped rather than carried into a filter the list would not
 * recognise.
 */
export const load: PageServerLoad = ({ url }) => {
  const params = new URLSearchParams(url.searchParams);
  params.delete('offset');
  params.set('triage', '1');
  redirect(302, `/admin/opportunities?${params.toString()}`);
};
