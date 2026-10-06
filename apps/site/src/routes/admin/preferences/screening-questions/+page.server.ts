import { fail, isHttpError } from '@sveltejs/kit';
import {
  createScreeningQuestion,
  deleteScreeningQuestion,
  listScreeningQuestions,
  ScreeningQuestionStoreError,
  updateScreeningQuestion,
} from '$lib/server/screening-question-store';
import {
  loadSkillExperience,
  saveSkillExperience,
} from '$lib/server/skill-experience-preferences';
import {
  requireCandidateWorkspaceSubject,
  WorkspaceSubjectError,
  workspaceSubjectFromLocals,
} from '$lib/server/workspace-subject';
import type { Actions, PageServerLoad } from './$types';

const text = (form: FormData, key: string) => {
  const value = form.get(key);
  return typeof value === 'string' ? value : '';
};
const subjectFor = (locals: App.Locals) =>
  requireCandidateWorkspaceSubject(workspaceSubjectFromLocals(locals));

export const load: PageServerLoad = async ({ locals }) => ({
  ...(await listScreeningQuestions(subjectFor(locals))),
  skillExperience: await loadSkillExperience(subjectFor(locals)),
});

export const actions: Actions = {
  saveSkillExperience: async ({ locals, request }) => {
    try {
      const form = await request.formData();
      await saveSkillExperience(
        subjectFor(locals),
        form.get('skillExperience'),
      );
      return {
        ok: true,
        action: 'skillExperience',
        message: 'Skill experience saved.',
      };
    } catch (cause) {
      if (cause instanceof WorkspaceSubjectError)
        return fail(cause.status, {
          ok: false,
          action: 'skillExperience',
          error: cause.message,
        });
      if (isHttpError(cause))
        return fail(cause.status, {
          ok: false,
          action: 'skillExperience',
          error: cause.body.message,
        });
      throw cause;
    }
  },
  save: async ({ locals, request }) => {
    try {
      const subject = subjectFor(locals);
      const form = await request.formData();
      const kind = text(form, 'kind');
      const importance = text(form, 'importance');
      const desiredAnswer = text(form, 'desiredAnswer');
      const active = text(form, 'active');
      if (
        (kind !== 'source' && kind !== 'fit') ||
        (importance !== 'must_have' &&
          importance !== 'preference' &&
          importance !== 'informational') ||
        (desiredAnswer !== 'yes' && desiredAnswer !== 'no') ||
        (active !== 'true' && active !== 'false')
      )
        throw new ScreeningQuestionStoreError(
          'invalid_question',
          400,
          'Screening question fields are invalid.',
        );
      const input = {
        text: text(form, 'text'),
        kind,
        importance,
        desiredAnswer,
        weight: Number(text(form, 'weight')),
        active: active === 'true',
      };
      const id = text(form, 'id');
      const snapshot = id
        ? await updateScreeningQuestion(subject, {
            id,
            expectedRevision: text(form, 'expectedRevision'),
            patch: input,
          })
        : await createScreeningQuestion(subject, input);
      return { ok: true, message: 'Screening question saved.', ...snapshot };
    } catch (cause) {
      if (
        cause instanceof ScreeningQuestionStoreError ||
        cause instanceof WorkspaceSubjectError
      )
        return fail(cause.status, { ok: false, error: cause.message });
      if (isHttpError(cause))
        return fail(cause.status, { ok: false, error: cause.body.message });
      throw cause;
    }
  },
  delete: async ({ locals, request }) => {
    try {
      const subject = subjectFor(locals);
      const form = await request.formData();
      const snapshot = await deleteScreeningQuestion(subject, {
        id: text(form, 'id'),
        expectedRevision: text(form, 'expectedRevision'),
      });
      return { ok: true, message: 'Screening question deleted.', ...snapshot };
    } catch (cause) {
      if (
        cause instanceof ScreeningQuestionStoreError ||
        cause instanceof WorkspaceSubjectError
      )
        return fail(cause.status, { ok: false, error: cause.message });
      if (isHttpError(cause))
        return fail(cause.status, { ok: false, error: cause.body.message });
      throw cause;
    }
  },
};
