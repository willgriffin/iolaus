import type { RequestHandler } from '@sveltejs/kit';
import { getLocalOAuth } from '$lib/server/local-oauth';
export const POST: RequestHandler = async ({ request }) => {
  const oauth = await getLocalOAuth();
  return oauth
    ? oauth.server.handle(request)
    : new Response(null, { status: 404 });
};
