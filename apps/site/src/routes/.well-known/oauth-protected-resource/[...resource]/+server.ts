import type { RequestHandler } from '@sveltejs/kit';
import { getLocalOAuth } from '$lib/server/local-oauth';
import { createIolausMcpResourceAuth } from '$lib/server/mcp-oauth';

/** RFC 9728 discovery for the optional OAuth-protected MCP endpoint only. */
export const GET: RequestHandler = async ({ url }) => {
  const local = await getLocalOAuth();
  if (local && url.pathname === '/.well-known/oauth-protected-resource/api/mcp')
    return Response.json(
      {
        resource: local.resource,
        authorization_servers: [local.issuer],
        scopes_supported: [
          'opportunities:read',
          'profile:read',
          'applications:prepare',
        ],
        bearer_methods_supported: ['header'],
      },
      { headers: { 'cache-control': 'no-store' } },
    );
  const auth = createIolausMcpResourceAuth();
  if (!auth || url.pathname !== new URL(auth.metadataUrl).pathname) {
    return new Response('Not found.', { status: 404 });
  }
  return auth.metadataResponse();
};
