import {
  publicLocationInputSchema,
  reversePublicLocation,
} from '$lib/server/public-location.js';
import { publicResponse } from '$lib/server/public-search/http.js';
import { PublicSearchError } from '$lib/server/public-search/index.js';
import type { RequestHandler } from './$types';

function parameters(url: URL) {
  const values: Record<string, string> = {};
  for (const [key, value] of url.searchParams) {
    if (key in values)
      throw new PublicSearchError(400, 'Duplicate query parameter');
    values[key] = value;
  }
  return publicLocationInputSchema.parse(values);
}

export const GET: RequestHandler = ({ request, url }) =>
  publicResponse(
    request,
    1,
    () => reversePublicLocation(parameters(url)),
    false,
  );
