import { error, redirect } from '@sveltejs/kit';
import {
  acceptOpportunityAction,
  crawlSourceNowAction,
  createDraftApplicationAction,
  createFactIntakeAction,
  createOpportunityRelationAction,
  deleteOpportunityRelationAction,
  loadAdminRecordPageData,
  processOpportunityAction,
  processOpportunityWithLlmAction,
  processRecommendationTaskAction,
  researchCompanyAction,
  reviewOpportunityAction,
} from '$lib/server/admin-resource-route';
import type { Actions, PageServerLoad } from './$types';

function requireOpportunityResource(resource: string): void {
  if (resource !== 'opportunities') {
    error(404, 'Relation editing is only available for opportunities.');
  }
}

function recordHref(resource: string, id: string): string {
  return `/admin/${resource}/${encodeURIComponent(id)}`;
}

export const load: PageServerLoad = async ({ params }) => {
  return await loadAdminRecordPageData(params.resource, params.id, {
    includeOpportunityRelations: params.resource === 'opportunities',
  });
};

export const actions: Actions = {
  crawlSourceNow: async ({ params, request }) => {
    return await crawlSourceNowAction(params.resource, request);
  },
  reviewOpportunity: async ({ locals, request }) => {
    return await reviewOpportunityAction(request, locals);
  },
  acceptOpportunity: async ({ locals, request }) => {
    return await acceptOpportunityAction(request, locals);
  },
  processOpportunityWithLlm: async ({ locals, request }) => {
    return await processOpportunityWithLlmAction(request, locals.user);
  },
  processOpportunity: async ({ locals, request }) => {
    return await processOpportunityAction(request, locals.user);
  },
  researchCompany: async ({ request }) => {
    return await researchCompanyAction(request);
  },
  createDraftApplication: async ({ locals, request }) => {
    return await createDraftApplicationAction(request, locals);
  },
  createFactIntake: async ({ locals, request }) => {
    return await createFactIntakeAction(request, locals);
  },
  processRecommendationTask: async ({ locals, request }) => {
    return await processRecommendationTaskAction(request, locals);
  },
  createOpportunityRelation: async ({ locals, params, request }) => {
    requireOpportunityResource(params.resource);
    await createOpportunityRelationAction(params.id, request, locals);
    redirect(303, recordHref(params.resource, params.id));
  },
  deleteOpportunityRelation: async ({ locals, params, request }) => {
    requireOpportunityResource(params.resource);
    await deleteOpportunityRelationAction(params.id, request, locals);
    redirect(303, recordHref(params.resource, params.id));
  },
};
