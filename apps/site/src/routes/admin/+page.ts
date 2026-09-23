import { redirect } from '@sveltejs/kit';
import type { PageLoad } from './$types';

// Client-side redirect (#96): no server round trip for the admin home link.
export const load: PageLoad = async () => {
  redirect(307, '/admin/tasks');
};
