import { createSessionHandler } from '@happyvertical/smrt-users/sveltekit';
import { type Handle, redirect, type ServerInit } from '@sveltejs/kit';
import { sequence } from '@sveltejs/kit/hooks';
import { building } from '$app/environment';
import { administrativeSessionFailure } from '$lib/server/administrative-auth';
import { ensureApplicationRuntimeReady } from '$lib/server/application-runtime';
import { sessionCookieName } from '$lib/server/auth';
import { getSmrtOptions } from '$lib/server/db';
import { getLocalOAuth } from '$lib/server/local-oauth';
import { startPublishedResumePrime } from '$lib/server/resume-prime';
import { refreshSkillVocabularyLookup } from '$lib/server/skill-vocabulary';
import { startRuntimeThenPrime } from '$lib/server/startup-readiness';
import { withBearerSessionContext } from '$lib/server/terminal-auth';
import {
  candidateProfileOnboardingRedirect,
  verifyWorkspaceSubject,
} from '$lib/server/workspace-subject';

// Warm the published resume before the readiness probe passes, so a fresh
// replica never serves a public request from a cold cache. Skipped during the
// build, which imports this module without a database.
export const init: ServerInit = async () => {
  if (building) return;
  // Do not block the server's request loop on an external provider. /health
  // owns its bounded readiness budget and /live must remain process-only.
  // Runtime initialisation retries with backoff (#100): a transient provider
  // failure at boot must not leave the pod unready until kubelet restarts it.
  void startRuntimeThenPrime({
    ensureRuntime: async () => {
      await ensureApplicationRuntimeReady();
      await getLocalOAuth();
      await refreshSkillVocabularyLookup();
    },
    prime: startPublishedResumePrime,
  });
};

const sessionHandler = createSessionHandler({
  ...getSmrtOptions(),
  autoExtend: true,
  cookieName: sessionCookieName,
  cookieSameSite: 'lax',
  enterTenantContext: true,
  skipPaths: ['/health', '/live'],
});

const authGuard: Handle = async ({ event, resolve }) => {
  const pathname = event.url.pathname;
  const protectedAdmin = pathname.startsWith('/admin');
  const protectedApi = pathname.startsWith('/api');
  const publicCatalogApi =
    pathname.startsWith('/api/public/v1/') &&
    !pathname.startsWith('/api/public/v1/me/');
  const publicApi =
    pathname === '/api/cli/auth/start' ||
    pathname === '/api/cli/auth/token' ||
    pathname === '/api/_runtime/health' ||
    pathname === '/api/mcp' ||
    pathname === '/api/mcp/tools' ||
    pathname === '/api/mcp/call' ||
    publicCatalogApi;

  if (protectedAdmin || (protectedApi && !publicApi)) {
    const failure = administrativeSessionFailure(event.locals);
    if (failure) {
      if (protectedApi) {
        return new Response(
          failure === 'unauthenticated' ? 'Unauthorized' : 'Forbidden',
          {
            status: failure === 'unauthenticated' ? 401 : 403,
            headers: { 'cache-control': 'private, no-store' },
          },
        );
      }

      if (event.locals.invitationRequired) {
        redirect(303, '/not-invited');
      }

      if (failure === 'unauthenticated') {
        const next = `${event.url.pathname}${event.url.search}`;
        redirect(303, `/login?next=${encodeURIComponent(next)}`);
      }
      return new Response('Forbidden', { status: 403 });
    }
  }

  if (protectedAdmin) {
    // A newly invited hosted user has an identity but no CandidateProfile until
    // onboarding creates one; every other admin page needs it.
    const onboarding = candidateProfileOnboardingRedirect(
      event.locals,
      pathname,
    );
    if (onboarding) redirect(303, onboarding);
  }

  return resolve(event);
};

/** JWT access tokens for the canonical MCP resource are verified by its OAuth
 * resource-auth handler. Opaque terminal bearer tokens keep the CLI path. */
function isMcpOAuthJwt(pathname: string, token: string): boolean {
  return (
    pathname === '/api/mcp' &&
    /^[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+){2}$/u.test(token)
  );
}

const bearerSessionHandler: Handle = async ({ event, resolve }) => {
  const authorization = event.request.headers.get('authorization');
  const match = authorization?.match(/^Bearer\s+(.+)$/iu);
  if (authorization !== null && !match)
    return new Response('Unauthorized', {
      status: 401,
      headers: { 'cache-control': 'private, no-store' },
    });

  if (match && !isMcpOAuthJwt(event.url.pathname, match[1].trim())) {
    return await withBearerSessionContext(match[1].trim(), async (context) => {
      if (context.session && context.user) {
        event.locals.user = context.user;
        event.locals.membership = context.membership ?? null;
        event.locals.permissions = context.permissions;
        event.locals.tenantId = context.tenantId;
        event.locals.sessionId = context.sessionId;
      }
      if (!context.session || !context.user)
        return new Response('Unauthorized', {
          status: 401,
          headers: { 'cache-control': 'private, no-store' },
        });
      return resolve(event);
    });
  }

  return resolve(event);
};

/** Refresh tenant membership and permissions after either session mechanism. */
const workspaceSubjectHandler: Handle = async ({ event, resolve }) => {
  await verifyWorkspaceSubject(event.locals);
  return resolve(event);
};

export const handle = sequence(
  sessionHandler as unknown as Handle,
  bearerSessionHandler,
  workspaceSubjectHandler,
  authGuard,
);
