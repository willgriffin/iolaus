import { mountMcpRoute } from '@happyvertical/smrt-app-mcp/sveltekit';
import {
  mcpAppServer,
  resolveMcpAppPrincipal,
} from '$lib/server/mcp-app-server';
import {
  createIolausMcpResourceAuth,
  isMcpOauthBearerRequest,
  withMcpOauthContext,
} from '$lib/server/mcp-oauth';

const options = {
  resolvePrincipal: (event: { locals?: Record<string, unknown> }) =>
    resolveMcpAppPrincipal((event.locals ?? {}) as unknown as App.Locals),
};

// Preserve the former REST-shaped GET compatibility endpoint while POST is
// the canonical stateless Streamable HTTP transport.
export { GET } from './tools/+server';

const canonicalPost = mountMcpRoute(mcpAppServer, options);

export const POST: typeof canonicalPost = async (event) => {
  const resourceAuth = createIolausMcpResourceAuth();
  // Opaque terminal-session Bearers remain on the established CLI route. A
  // three-segment Bearer is an OAuth access token and must pass the resource
  // adapter; cookie requests retain their current authenticated flow.
  if (!resourceAuth || !isMcpOauthBearerRequest(event.request)) {
    return await canonicalPost(event);
  }
  const authenticated = await resourceAuth.authenticate(event.request);
  if (!authenticated.ok) return authenticated.response;
  return await withMcpOauthContext(
    event,
    authenticated.principal,
    canonicalPost,
  );
};
