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
  loadAdminResourcePageShellData,
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
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = ({ locals, params, url }) =>
  loadAdminResourcePageShellData(params.resource, url, {
    tenantId: locals.tenantId,
    user: locals.user ? { id: locals.user.id } : null,
  });

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
  triageQueue: async ({ request }) => {
    return await triageQueueAction(request);
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
    return await processOpportunityWithLlmAction(request, locals.user);
  },
  processOpportunity: async ({ locals, request }) => {
    return await processOpportunityAction(request, locals.user);
  },
  createDraftApplication: async ({ locals, request }) => {
    return await createDraftApplicationAction(request, locals);
  },
  createFactIntake: async ({ locals, request }) => {
    return await createFactIntakeAction(request, locals);
  },
  syncRecommendationTasks: async ({ params }) => {
    return await syncRecommendationTasksAction(params.resource);
  },
  processRecommendationTask: async ({ locals, request }) => {
    return await processRecommendationTaskAction(request, locals);
  },
  acceptFactCandidate: async ({ locals, request }) => {
    return await acceptFactCandidateAction(request, locals.user);
  },
};
