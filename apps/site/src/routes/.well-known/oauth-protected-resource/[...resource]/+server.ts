import type { RequestHandler } from '@sveltejs/kit';
import { createIolausMcpResourceAuth } from '$lib/server/mcp-oauth';

/** RFC 9728 discovery for the optional OAuth-protected MCP endpoint only. */
export const GET: RequestHandler = ({ url }) => {
  const auth = createIolausMcpResourceAuth();
  if (!auth || url.pathname !== new URL(auth.metadataUrl).pathname) {
    return new Response('Not found.', { status: 404 });
  }
  return auth.metadataResponse();
};
