import { fail, isHttpError } from '@sveltejs/kit';
import {
  loadProfileLinkEditor,
  saveProfileLink,
} from '$lib/server/profile-link-editor';
import type { Actions, PageServerLoad } from './$types';
export const load: PageServerLoad = async ({ locals }) =>
  await loadProfileLinkEditor(locals);
export const actions: Actions = {
  save: async ({ locals, request }) => {
    try {
      return await saveProfileLink(locals, await request.formData());
    } catch (cause) {
      if (isHttpError(cause))
        return fail(cause.status, { ok: false, error: cause.body.message });
      throw cause;
    }
  },
};
