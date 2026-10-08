import type { RequestHandler } from '@sveltejs/kit';
import { getLocalOAuth } from '$lib/server/local-oauth';
export const POST: RequestHandler = async ({ request }) => {
  const oauth = await getLocalOAuth();
  if (!oauth) return new Response(null, { status: 404 });
  try {
    const metadata = await request.clone().json();
    if (
      !Array.isArray(metadata.redirect_uris) ||
      metadata.redirect_uris.some(
        (value: unknown) =>
          typeof value !== 'string' || new URL(value).protocol !== 'https:',
      )
    )
      throw new Error();
  } catch {
    return Response.json(
      {
        error: 'invalid_request',
        error_description: 'HTTPS redirect URIs are required.',
      },
      { status: 400, headers: { 'cache-control': 'no-store' } },
    );
  }
  return oauth.server.handle(request);
};
