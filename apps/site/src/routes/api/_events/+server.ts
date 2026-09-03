import {
  buildChangeEventStream,
  eventStreamCapacityExceededResponse,
  resolveDispatchTenantScope,
  tryReserveChangeEventSubscriberSlot,
} from '@happyvertical/smrt-core';
import {
  enterTenantContext,
  hasTenantContext,
} from '@happyvertical/smrt-tenancy';
import { manifestHash } from '@happyvertical/smrt-virt-web';
import { error, type RequestHandler } from '@sveltejs/kit';
import { getCollection } from '$lib/server/smrt';

function requireAuthenticatedPrincipal(locals: unknown): void {
  if (!locals || typeof locals !== 'object')
    throw error(401, 'Authentication required');

  const { session, smrtAuth, user } = locals as Record<string, unknown>;
  if (
    (typeof user === 'object' && user !== null) ||
    (typeof session === 'object' && session !== null) ||
    smrtAuth === true
  )
    return;

  throw error(401, 'Authentication required');
}

function establishTenantContext(locals: unknown): void {
  if (hasTenantContext() || !locals || typeof locals !== 'object') return;

  const { session, tenantId, user } = locals as Record<string, unknown>;
  const sessionTenantId =
    session && typeof session === 'object'
      ? (session as Record<string, unknown>).tenantId
      : undefined;
  const userTenantId =
    user && typeof user === 'object'
      ? (user as Record<string, unknown>).tenantId
      : undefined;
  const resolvedTenantId = tenantId ?? userTenantId ?? sessionTenantId;

  if (typeof resolvedTenantId === 'string' && resolvedTenantId)
    enterTenantContext({ tenantId: resolvedTenantId });
}

function parseCursor(request: Request, url: URL): number | null {
  const value =
    request.headers.get('Last-Event-ID') ?? url.searchParams.get('since');
  if (value === null || value.trim() === '') return null;

  const cursor = Number(value);
  return Number.isFinite(cursor) && cursor >= 0 ? Math.floor(cursor) : null;
}

/**
 * Authenticated, tenant-scoped SMRT live invalidation stream.
 *
 * This app owns its API routes, so SMRT's SvelteKit route generator is disabled
 * in Vite configuration. Keep this thin wrapper aligned with its generated
 * `_events` route rather than falling back to an unconditional polling loop.
 */
export const GET: RequestHandler = async ({ locals, request, url }) => {
  requireAuthenticatedPrincipal(locals);
  establishTenantContext(locals);

  const collection = await getCollection('Achievement');
  const releaseSubscriberSlot = tryReserveChangeEventSubscriberSlot(
    collection.db,
  );
  if (!releaseSubscriberSlot) return eventStreamCapacityExceededResponse();

  return new Response(
    buildChangeEventStream(collection.db, {
      cursor: parseCursor(request, url),
      manifestHash,
      releaseSubscriberSlot,
      tenantScope: resolveDispatchTenantScope(),
    }),
    {
      headers: {
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        'Content-Type': 'text/event-stream',
        'X-Accel-Buffering': 'no',
      },
      status: 200,
    },
  );
};
