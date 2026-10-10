import { publicOpportunityOpenApi } from '$lib/public-opportunity-contract.js';
import { publicResponse } from '$lib/server/public-search/http.js';
import type { RequestHandler } from './$types';
export const GET: RequestHandler = ({ request }) =>
  publicResponse(request, 1, () => publicOpportunityOpenApi);
