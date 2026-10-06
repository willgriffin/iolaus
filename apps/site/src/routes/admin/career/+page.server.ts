import { fail, isHttpError } from '@sveltejs/kit';
import {
  loadCareerManagement,
  saveCareerSection,
} from '$lib/server/career-management';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals }) =>
  await loadCareerManagement(locals);
export const actions: Actions = {
  save: async ({ locals, request }) => {
    try {
      return await saveCareerSection(locals, await request.formData());
    } catch (cause) {
      if (isHttpError(cause))
        return fail(cause.status, { ok: false, error: cause.body.message });
      throw cause;
    }
  },
};
