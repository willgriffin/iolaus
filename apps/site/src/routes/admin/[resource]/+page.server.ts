import {
  acceptFactCandidateAction,
  acceptOpportunityAction,
  applyInactiveOpportunitySweepAction,
  bulkReviewOpportunitiesAction,
  crawlSourceNowAction,
  createAdminResourceAction,
  createDraftApplicationAction,
  createFactIntakeAction,
  deleteAdminResourceAction,
  digDeeperOpportunityAction,
  loadOpportunityDetailsAction,
  previewInactiveOpportunitySweepAction,
  processOpportunityAction,
  processOpportunityWithLlmAction,
  processRecommendationTaskAction,
  reviewOpportunityAction,
  syncRecommendationTasksAction,
  triageQueueAction,
  updateAdminResourceAction,
  verifyOpportunityPostingAction,
} from '$lib/server/admin-resource-route';
import { workspaceSubjectFromLocals } from '$lib/server/workspace-subject.js';
import type { Actions } from './$types';

export const actions: Actions = {
  create: async ({ locals, params, request }) => {
    return await createAdminResourceAction(
      params.resource,
      request,
      locals.user,
    );
  },
  update: async ({ locals, params, request }) => {
    return await updateAdminResourceAction(
      params.resource,
      request,
      locals.user,
    );
  },
  delete: async ({ params, request }) => {
    return await deleteAdminResourceAction(params.resource, request);
  },
  crawlSourceNow: async ({ params, request }) => {
    return await crawlSourceNowAction(params.resource, request);
  },
  reviewOpportunity: async ({ locals, request }) => {
    return await reviewOpportunityAction(request, locals);
  },
  acceptOpportunity: async ({ locals, request }) => {
    return await acceptOpportunityAction(request, locals);
  },
  // The triage deck is a modal over this list, so its queue read and its two
  // decision writes are this route's actions — the same owner-principal
  // helpers the list toolbar already posts to, never a second write path.
  triageQueue: async ({ locals, request }) => {
    return await triageQueueAction(request, workspaceSubjectFromLocals(locals));
  },
  digDeeper: async ({ locals, request }) => {
    return await digDeeperOpportunityAction(request, locals);
  },
  verifyPosting: async ({ locals, request }) => {
    return await verifyOpportunityPostingAction(request, locals);
  },
  bulkReviewOpportunities: async ({ locals, request }) => {
    return await bulkReviewOpportunitiesAction(request, locals);
  },
  previewInactiveOpportunitySweep: async ({ locals, request }) => {
    return await previewInactiveOpportunitySweepAction(request, locals);
  },
  applyInactiveOpportunitySweep: async ({ locals, request }) => {
    return await applyInactiveOpportunitySweepAction(request, locals);
  },
  loadOpportunityDetails: async ({ request }) => {
    return await loadOpportunityDetailsAction(request);
  },
  processOpportunityWithLlm: async ({ locals, request }) => {
    return await processOpportunityWithLlmAction(request, locals);
  },
  processOpportunity: async ({ locals, request }) => {
    return await processOpportunityAction(request, locals);
  },
  createDraftApplication: async ({ locals, request }) => {
    return await createDraftApplicationAction(request, locals);
  },
  createFactIntake: async ({ locals, request }) => {
    return await createFactIntakeAction(request, locals);
  },
  syncRecommendationTasks: async ({ locals, params }) => {
    return await syncRecommendationTasksAction(params.resource, locals);
  },
  processRecommendationTask: async ({ locals, request }) => {
    return await processRecommendationTaskAction(request, locals);
  },
  acceptFactCandidate: async ({ locals, request }) => {
    return await acceptFactCandidateAction(request, locals);
  },
};
