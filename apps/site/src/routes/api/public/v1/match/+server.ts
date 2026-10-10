import { publicResponse } from '$lib/server/public-search/http.js';
import {
  matchPublicSkills,
  PublicSearchError,
} from '$lib/server/public-search/index.js';
import type { RequestHandler } from './$types';
export const POST: RequestHandler = ({ request }) =>
  publicResponse(
    request,
    10,
    async () => {
      if (Number(request.headers.get('content-length') ?? 0) > 16384)
        throw new PublicSearchError(400, 'Request body too large');
      const reader = request.body?.getReader();
      let size = 0;
      const chunks = [];
      if (reader) {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          size += value.length;
          if (size > 16384) {
            await reader.cancel();
            throw new PublicSearchError(400, 'Request body too large');
          }
          chunks.push(value);
        }
      }
      let input;
      try {
        input = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      } catch {
        throw new PublicSearchError(400, 'Invalid JSON');
      }
      return matchPublicSkills(input);
    },
    false,
  );
