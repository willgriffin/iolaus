import { fail, isHttpError } from '@sveltejs/kit';
import { isSharedHosted } from '$lib/server/app-config';
import {
  loadCareerManagement,
  saveCareerSection,
} from '$lib/server/career-management';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals }) => ({
  ...(await loadCareerManagement(locals)),
  publicProfilesEnabled:
    isSharedHosted() && process.env.IOLAUS_PUBLIC_PROFILES_ENABLED === 'true',
});
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
