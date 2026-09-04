import { createSessionHandler } from '@happyvertical/smrt-users/sveltekit';
import { type Handle, redirect, type ServerInit } from '@sveltejs/kit';
import { sequence } from '@sveltejs/kit/hooks';
import { building } from '$app/environment';
import { ensureApplicationRuntimeReady } from '$lib/server/application-runtime';
import { sessionCookieName } from '$lib/server/auth';
import { getSmrtOptions } from '$lib/server/db';
import { startPublishedResumePrime } from '$lib/server/resume-prime';
import { withBearerSessionContext } from '$lib/server/terminal-auth';

// Warm the published resume before the readiness probe passes, so a fresh
// replica never serves a public request from a cold cache. Skipped during the
// build, which imports this module without a database.
export const init: ServerInit = async () => {
  if (building) return;
  await ensureApplicationRuntimeReady();
  startPublishedResumePrime();
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
  const publicApi =
    pathname === '/api/cli/auth/start' ||
    pathname === '/api/cli/auth/token' ||
    pathname === '/api/_runtime/health' ||
    pathname === '/api/mcp' ||
    pathname === '/api/mcp/tools' ||
    pathname === '/api/mcp/call';

  if ((protectedAdmin || (protectedApi && !publicApi)) && !event.locals.user) {
    if (protectedApi) {
      return new Response('Unauthorized', { status: 401 });
    }

    const next = `${event.url.pathname}${event.url.search}`;
    redirect(303, `/login?next=${encodeURIComponent(next)}`);
  }

  return resolve(event);
};

const bearerSessionHandler: Handle = async ({ event, resolve }) => {
  if (!event.locals.user) {
    const authorization = event.request.headers.get('authorization');
    const match = authorization?.match(/^Bearer\s+(.+)$/iu);

    if (match) {
      return await withBearerSessionContext(
        match[1].trim(),
        async (context) => {
          if (context.session && context.user) {
            event.locals.user = context.user;
            event.locals.membership = context.membership ?? null;
            event.locals.permissions = context.permissions;
            event.locals.tenantId = context.tenantId;
            event.locals.sessionId = context.sessionId;
          }
          return resolve(event);
        },
      );
    }
  }

  return resolve(event);
};

export const handle = sequence(
  sessionHandler as unknown as Handle,
  bearerSessionHandler,
  authGuard,
);
