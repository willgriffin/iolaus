import { fail, isHttpError } from '@sveltejs/kit';
import {
  loadMatchingPreferences,
  saveMatchingPreferences,
} from '$lib/server/matching-preferences.js';
import { MATCHING_WORK_MODES } from '$lib/server/matching-projection-input.js';
import {
  requireCandidateWorkspaceSubject,
  WorkspaceSubjectError,
  workspaceSubjectFromLocals,
} from '$lib/server/workspace-subject.js';
import type { Actions, PageServerLoad } from './$types';

const subjectFor = (locals: App.Locals) =>
  requireCandidateWorkspaceSubject(workspaceSubjectFromLocals(locals));

export const load: PageServerLoad = async ({ locals }) => ({
  preferences: await loadMatchingPreferences(subjectFor(locals)),
  workModes: MATCHING_WORK_MODES,
});

export const actions: Actions = {
  default: async ({ locals, request }) => {
    try {
      await saveMatchingPreferences(
        subjectFor(locals),
        await request.formData(),
      );
      return {
        message:
          'Matching preferences saved. Matches will refresh in the background.',
      };
    } catch (cause) {
      if (cause instanceof WorkspaceSubjectError)
        return fail(cause.status, { error: cause.message });
      if (isHttpError(cause))
        return fail(cause.status, { error: cause.body.message });
      throw cause;
    }
  },
};
