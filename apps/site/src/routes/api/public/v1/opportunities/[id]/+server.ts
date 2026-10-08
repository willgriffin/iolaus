import { publicOpportunityInputSchema } from '$lib/public-opportunity-contract.js';
import { publicResponse } from '$lib/server/public-search/http.js';
import {
  getPublicOpportunity,
  PublicSearchError,
} from '$lib/server/public-search/index.js';
import type { RequestHandler } from './$types';
export const GET: RequestHandler = ({ request, params }) =>
  publicResponse(request, 1, async () => {
    const { id } = publicOpportunityInputSchema.parse({ id: params.id });
    const result = await getPublicOpportunity(id);
    if (!result) throw new PublicSearchError(404, 'Opportunity not found');
    return result;
  });
