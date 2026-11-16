import {
  publicResponse,
  publicSearchParameters,
} from '$lib/server/public-search/http.js';
import { searchPublicOpportunityResults } from '$lib/server/public-search/index.js';
import type { RequestHandler } from './$types';

/** Browser pagination can continue when exact catalog metadata is unavailable. */
export const GET: RequestHandler = ({ request, url }) =>
  publicResponse(request, 3, () =>
    searchPublicOpportunityResults(publicSearchParameters(url)),
  );
