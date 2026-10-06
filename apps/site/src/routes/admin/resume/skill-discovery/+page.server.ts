import { fail, isHttpError } from '@sveltejs/kit';
import {
  CandidateSkillDiscoveryError,
  confirmCandidateSkillProposal,
  discoverCandidateSkills,
  dismissCandidateSkillProposal,
  loadCandidateSkillDiscovery,
} from '$lib/server/candidate-skill-discovery';
import {
  requireCandidateWorkspaceSubject,
  WorkspaceSubjectError,
  workspaceSubjectFromLocals,
} from '$lib/server/workspace-subject';
import type { Actions, PageServerLoad } from './$types';

const subjectFor = (locals: App.Locals) =>
  requireCandidateWorkspaceSubject(workspaceSubjectFromLocals(locals));
const text = (form: FormData, key: string) =>
  typeof form.get(key) === 'string' ? String(form.get(key)) : '';
export const load: PageServerLoad = async ({ locals }) => ({
  snapshot: await loadCandidateSkillDiscovery(subjectFor(locals)),
});
function failure(cause: unknown) {
  if (
    cause instanceof WorkspaceSubjectError ||
    cause instanceof CandidateSkillDiscoveryError
  )
    return fail(cause.status, { ok: false, error: cause.message });
  if (isHttpError(cause))
    return fail(cause.status, { ok: false, error: cause.body.message });
  throw cause;
}
export const actions: Actions = {
  discover: async ({ locals }) => {
    try {
      const snapshot = await discoverCandidateSkills(subjectFor(locals));
      return {
        ok: true,
        message:
          snapshot.status === 'partial'
            ? 'Discovery paused at a safe batch limit. Continue to assess the remaining skills; review proposals before adding them.'
            : 'Discovery complete. Review each proposal before adding it.',
        snapshot,
      };
    } catch (cause) {
      return failure(cause);
    }
  },
  confirm: async ({ locals, request }) => {
    try {
      const subject = subjectFor(locals);
      const form = await request.formData();
      const snapshot = await confirmCandidateSkillProposal(subject, {
        id: text(form, 'id'),
        expectedRevision: text(form, 'expectedRevision'),
      });
      return {
        ok: true,
        message:
          'Skill confirmed privately. Public resume publication is separate.',
        snapshot,
      };
    } catch (cause) {
      return failure(cause);
    }
  },
  dismiss: async ({ locals, request }) => {
    try {
      const subject = subjectFor(locals);
      const form = await request.formData();
      const snapshot = await dismissCandidateSkillProposal(subject, {
        id: text(form, 'id'),
        expectedRevision: text(form, 'expectedRevision'),
      });
      return { ok: true, message: 'Proposal dismissed.', snapshot };
    } catch (cause) {
      return failure(cause);
    }
  },
};
