import { mountMcpRoute } from '@happyvertical/smrt-app-mcp/sveltekit';
import { withPrincipalPermissionContext } from '@happyvertical/smrt-users';
import { decodeProtectedHeader } from 'jose';
import { getSmrtOptions } from '$lib/server/db';
import { getLocalOAuth, oauthFailure } from '$lib/server/local-oauth';
import {
  mcpAppServer,
  resolveMcpAppPrincipal,
} from '$lib/server/mcp-app-server';
import {
  createIolausMcpResourceAuth,
  isMcpOauthBearerRequest,
  withMcpOauthContext,
} from '$lib/server/mcp-oauth';
import { verifyWorkspaceSubject } from '$lib/server/workspace-subject';

const options = {
  resolvePrincipal: (event: { locals?: Record<string, unknown> }) =>
    resolveMcpAppPrincipal((event.locals ?? {}) as unknown as App.Locals),
};

// Preserve the former REST-shaped GET compatibility endpoint while POST is
// the canonical stateless Streamable HTTP transport.
import { GET as compatibilityGet } from './tools/+server';

const canonicalPost = mountMcpRoute(mcpAppServer, options);

async function authenticatedRequest(
  event: Parameters<typeof canonicalPost>[0],
  execute: typeof canonicalPost,
): Promise<Response> {
  const local = await getLocalOAuth();
  if (local && isMcpOauthBearerRequest(event.request)) {
    try {
      const token = (event.request.headers.get('authorization') ?? '').replace(
        /^Bearer +/iu,
        '',
      );
      if (decodeProtectedHeader(token).typ !== 'at+jwt')
        throw new Error('Unsupported local token type.');
      const payload = await local.server.verifyAccessToken(
        token,
        local.resource,
      );
      if (
        typeof payload.exp !== 'number' ||
        typeof payload.iat !== 'number' ||
        typeof payload.sub !== 'string' ||
        typeof payload.scope !== 'string' ||
        typeof payload.client_id !== 'string'
      )
        return oauthFailure();
      const context =
        await local.authorization.validateAccessTokenClaims(payload);
      if (!context?.user || !context.tenantId) return oauthFailure();
      return await withPrincipalPermissionContext(
        {
          ...getSmrtOptions(),
          userId: context.user.id as string,
          tenantId: context.tenantId,
          enterTenantContext: true,
        },
        async () => {
          const locals = {
            ...event.locals,
            user: context.user,
            membership: context.membership,
            tenantId: context.tenantId,
            permissions: context.permissions,
          } as App.Locals;
          if (!(await verifyWorkspaceSubject(locals))) return oauthFailure();
          locals.permissions = locals.permissions.filter((permission) =>
            context.permissions.includes(permission),
          );
          return execute({
            ...event,
            locals: locals as unknown as Record<string, unknown>,
          });
        },
      );
    } catch {
      // An external issuer may still be configured; its independent verifier must succeed.
      const external = createIolausMcpResourceAuth();
      if (!external) return oauthFailure();
    }
  }
  const resourceAuth = createIolausMcpResourceAuth();
  if (!resourceAuth && isMcpOauthBearerRequest(event.request))
    return oauthFailure();
  // Opaque terminal-session Bearers remain on the established CLI route. A
  // three-segment Bearer is an OAuth access token and must pass the resource
  // adapter; cookie requests retain their current authenticated flow.
  if (!resourceAuth || !isMcpOauthBearerRequest(event.request)) {
    return await execute(event);
  }
  const authenticated = await resourceAuth.authenticate(event.request);
  if (!authenticated.ok) return authenticated.response;
  return await withMcpOauthContext(event, authenticated.principal, execute);
}

export const POST: typeof canonicalPost = (event) =>
  authenticatedRequest(event, canonicalPost);
export const GET: typeof canonicalPost = (event) =>
  authenticatedRequest(
    event,
    compatibilityGet as unknown as typeof canonicalPost,
  );
