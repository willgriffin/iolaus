import {
  publicResponse,
  publicSearchParameters,
} from '$lib/server/public-search/http.js';
import { listPublicFacets } from '$lib/server/public-search/index.js';
import type { RequestHandler } from './$types';
export const GET: RequestHandler = ({ request, url }) =>
  publicResponse(request, 6, () =>
    listPublicFacets(publicSearchParameters(url)),
  );
