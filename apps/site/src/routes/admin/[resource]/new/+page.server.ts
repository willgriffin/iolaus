import { redirect } from '@sveltejs/kit';
import {
  createAdminResourceAction,
  loadAdminCreatePageData,
} from '$lib/server/admin-resource-route';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ params }) => {
  return await loadAdminCreatePageData(params.resource);
};

export const actions: Actions = {
  create: async ({ locals, params, request }) => {
    const record = await createAdminResourceAction(
      params.resource,
      request,
      locals.user,
    );
    redirect(303, `/admin/${params.resource}/${record.id ?? ''}`);
  },
};
