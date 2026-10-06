import { redirect } from '@sveltejs/kit';
import { archiveApplicationAction } from '$lib/server/admin-resource-route';
import { generateApplicationPackage } from '$lib/server/application-package';
import {
  addApplicationMaterialComments,
  approveApplicationForSubmission,
  loadApplicationReviewPageData,
  markApplicationMaterialReviewed,
  recordApplicationSubmissionBlockerFromReview,
  recordApplicationSubmissionFromReview,
  requestApplicationMaterialTweaks,
} from '$lib/server/application-review';
import {
  recordApplicationFormAnswers,
  revokeReusableAnswerByLabelKey,
} from '$lib/server/application-workflow';
import { requireWorkspaceSubject } from '$lib/server/private-workspace';
import {
  requireCandidateWorkspaceSubject,
  workspaceSubjectFromLocals,
} from '$lib/server/workspace-subject';
import type { Actions, PageServerLoad } from './$types';

function subjectFromLocals(locals: App.Locals) {
  // The hook owns this selected-profile value. Runtime validation still rejects
  // a session that lacks it before any private application record is read.
  return requireWorkspaceSubject(
    requireCandidateWorkspaceSubject(workspaceSubjectFromLocals(locals)),
  );
}

export const load: PageServerLoad = async ({ locals, params }) => {
  return await loadApplicationReviewPageData(
    params.id,
    subjectFromLocals(locals),
  );
};

export const actions: Actions = {
  archiveApplication: async ({ locals, params }) => {
    await archiveApplicationAction(params.id, locals);
    redirect(303, '/admin/applications?status=archived');
  },
  addComments: async ({ locals, params, request }) => {
    return await addApplicationMaterialComments(
      params.id,
      request,
      subjectFromLocals(locals),
    );
  },
  approveFinal: async ({ locals, params, request }) => {
    return await approveApplicationForSubmission(
      params.id,
      request,
      subjectFromLocals(locals),
    );
  },
  generatePacket: async ({ locals, params, request }) => {
    const form = await request.formData();
    const preflightOverrideReason = form.get('preflightOverrideReason');
    await generateApplicationPackage(params.id, {
      preflightOverrideReason:
        typeof preflightOverrideReason === 'string'
          ? preflightOverrideReason
          : '',
      signal: request.signal,
      subject: subjectFromLocals(locals),
      user: locals.user,
    });
    return { status: 'packet_generated' };
  },
  provideAnswers: async ({ locals, params, request }) => {
    const result = await recordApplicationFormAnswers(
      params.id,
      request,
      subjectFromLocals(locals),
    );
    return { status: 'answers_saved', ...result };
  },
  revokeReusableAnswer: async ({ locals, request }) => {
    const form = await request.formData();
    const labelKey = String(form.get('labelKey') ?? '');
    const revoked = await revokeReusableAnswerByLabelKey(
      labelKey,
      subjectFromLocals(locals),
    );
    return { status: 'reusable_answer_revoked', revokedForReuse: revoked };
  },
  recordSubmission: async ({ locals, params, request }) => {
    return await recordApplicationSubmissionFromReview(
      params.id,
      request,
      subjectFromLocals(locals),
    );
  },
  reportBlocker: async ({ locals, params, request }) => {
    return await recordApplicationSubmissionBlockerFromReview(
      params.id,
      request,
      subjectFromLocals(locals),
    );
  },
  requestTweaks: async ({ locals, params, request }) => {
    return await requestApplicationMaterialTweaks(
      params.id,
      request,
      subjectFromLocals(locals),
    );
  },
  reviewMaterial: async ({ locals, params, request }) => {
    return await markApplicationMaterialReviewed(
      params.id,
      request,
      subjectFromLocals(locals),
    );
  },
};
