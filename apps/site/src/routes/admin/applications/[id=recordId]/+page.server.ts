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
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ params }) => {
  return await loadApplicationReviewPageData(params.id);
};

export const actions: Actions = {
  addComments: async ({ locals, params, request }) => {
    return await addApplicationMaterialComments(
      params.id,
      request,
      locals.user,
    );
  },
  approveFinal: async ({ locals, params, request }) => {
    return await approveApplicationForSubmission(
      params.id,
      request,
      locals.user,
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
      user: locals.user,
    });
    return { status: 'packet_generated' };
  },
  provideAnswers: async ({ params, request }) => {
    const result = await recordApplicationFormAnswers(params.id, request);
    return { status: 'answers_saved', ...result };
  },
  revokeReusableAnswer: async ({ request }) => {
    const form = await request.formData();
    const labelKey = String(form.get('labelKey') ?? '');
    const revoked = await revokeReusableAnswerByLabelKey(labelKey);
    return { status: 'reusable_answer_revoked', revokedForReuse: revoked };
  },
  recordSubmission: async ({ locals, params, request }) => {
    return await recordApplicationSubmissionFromReview(
      params.id,
      request,
      locals.user,
    );
  },
  reportBlocker: async ({ locals, params, request }) => {
    return await recordApplicationSubmissionBlockerFromReview(
      params.id,
      request,
      locals.user,
    );
  },
  requestTweaks: async ({ locals, params, request }) => {
    return await requestApplicationMaterialTweaks(
      params.id,
      request,
      locals.user,
    );
  },
  reviewMaterial: async ({ locals, params, request }) => {
    return await markApplicationMaterialReviewed(
      params.id,
      request,
      locals.user,
    );
  },
};
