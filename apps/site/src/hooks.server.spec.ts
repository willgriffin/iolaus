import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  contextActive: false,
  ensureApplicationRuntimeReady: vi.fn(),
  withBearerSessionContext: vi.fn(),
}));

vi.mock('$app/environment', () => ({ building: false }));

vi.mock('$lib/server/application-runtime', async (importOriginal) => ({
  ...(await importOriginal<typeof import('$lib/server/application-runtime')>()),
  ensureApplicationRuntimeReady: mocks.ensureApplicationRuntimeReady,
}));

vi.mock('@happyvertical/smrt-users/sveltekit', () => ({
  createSessionHandler: vi.fn(
    () =>
      async ({
        event,
        resolve,
      }: {
        event: unknown;
        resolve: (event: unknown) => Promise<Response>;
      }) =>
        await resolve(event),
  ),
}));

vi.mock('@sveltejs/kit/hooks', () => ({
  sequence:
    (
      ...handlers: Array<(input: Record<string, unknown>) => Promise<Response>>
    ) =>
    async ({ event, resolve }: Record<string, unknown>) => {
      const invoke = async (
        index: number,
        nextEvent: unknown,
      ): Promise<Response> => {
        const handler = handlers[index];
        if (!handler) {
          return await (resolve as (event: unknown) => Promise<Response>)(
            nextEvent,
          );
        }
        return await handler({
          event: nextEvent,
          resolve: (resolvedEvent: unknown) => invoke(index + 1, resolvedEvent),
        });
      };
      return await invoke(0, event);
    },
}));

vi.mock('$lib/server/resume-prime', () => ({
  startPublishedResumePrime: vi.fn(),
}));

vi.mock('$lib/server/terminal-auth', () => ({
  withBearerSessionContext: mocks.withBearerSessionContext,
}));

function event(
  token: string | null = 'terminal-token',
  pathname = '/api/job-search/browse',
): {
  cookies: { get: ReturnType<typeof vi.fn> };
  locals: {
    membership: {
      id: string;
      roleId?: string;
      status?: string;
      tenantId?: string;
      userId?: string;
    } | null;
    permissions: string[];
    sessionId: string | null;
    tenantId: string | null;
    user: { id: string; status?: string } | null;
  };
  request: Request;
  url: URL;
} {
  return {
    cookies: { get: vi.fn(() => undefined) },
    locals: {
      membership: null,
      permissions: [],
      sessionId: null,
      tenantId: null,
      user: null,
    },
    request: new Request(`https://iolaus.localhost${pathname}`, {
      headers: token ? { authorization: `Bearer ${token}` } : undefined,
    }),
    url: new URL(`https://iolaus.localhost${pathname}`),
  };
}

describe('server bearer-session handling', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.contextActive = false;
    mocks.ensureApplicationRuntimeReady.mockResolvedValue(undefined);
  });

  it('does not block process startup on a pending provider readiness check', async () => {
    let resolveRuntime: (() => void) | undefined;
    mocks.ensureApplicationRuntimeReady.mockReturnValue(
      new Promise<void>((resolve) => {
        resolveRuntime = resolve;
      }),
    );
    const { init } = await import('./hooks.server');

    await expect(init()).resolves.toBeUndefined();
    expect(mocks.ensureApplicationRuntimeReady).toHaveBeenCalledOnce();

    const { startPublishedResumePrime } = await import(
      '$lib/server/resume-prime'
    );
    expect(startPublishedResumePrime).not.toHaveBeenCalled();
    resolveRuntime?.();
    await Promise.resolve();
    expect(startPublishedResumePrime).toHaveBeenCalledOnce();
  });

  it('resolves protected APIs inside the bearer tenant and database context', async () => {
    const membership = {
      id: 'membership-1',
      roleId: 'admin-role',
      status: 'active',
      tenantId: 'tenant-1',
      userId: 'user-1',
    };
    const user = { id: 'user-1', status: 'active' };
    mocks.withBearerSessionContext.mockImplementation(
      async (
        _token: string,
        fn: (context: Record<string, unknown>) => unknown,
      ) => {
        mocks.contextActive = true;
        try {
          return await fn({
            membership,
            permissions: ['opportunities.read'],
            session: { id: 'session-1' },
            sessionId: 'session-1',
            tenantId: 'tenant-1',
            user,
          });
        } finally {
          mocks.contextActive = false;
        }
      },
    );
    const requestEvent = event();
    const resolve = vi.fn(async () => {
      expect(mocks.contextActive).toBe(true);
      return new Response('ok');
    });
    const { handle } = await import('./hooks.server');

    const response = await handle({ event: requestEvent, resolve } as never);

    expect(response.status).toBe(200);
    expect(mocks.withBearerSessionContext).toHaveBeenCalledWith(
      'terminal-token',
      expect.any(Function),
    );
    expect(requestEvent.locals).toMatchObject({
      membership,
      permissions: ['opportunities.read'],
      sessionId: 'session-1',
      tenantId: 'tenant-1',
      user,
    });
    expect(resolve).toHaveBeenCalledOnce();
  });

  it('leaves an invalid bearer token unauthenticated', async () => {
    mocks.withBearerSessionContext.mockImplementation(
      async (
        _token: string,
        fn: (context: Record<string, unknown>) => unknown,
      ) =>
        await fn({
          membership: null,
          permissions: [],
          session: null,
          sessionId: null,
          tenantId: null,
          user: null,
        }),
    );
    const resolve = vi.fn(async () => new Response('unexpected'));
    const { handle } = await import('./hooks.server');

    const response = await handle({
      event: event('invalid'),
      resolve,
    } as never);

    expect(response.status).toBe(401);
    expect(resolve).not.toHaveBeenCalled();
  });

  it('preserves an established cookie session instead of replacing it', async () => {
    const requestEvent = event('different-bearer');
    const cookieUser = { id: 'cookie-user', status: 'active' };
    requestEvent.locals.user = cookieUser;
    requestEvent.locals.tenantId = 'cookie-tenant';
    requestEvent.locals.membership = {
      id: 'membership-1',
      roleId: 'admin-role',
      status: 'active',
      tenantId: 'cookie-tenant',
      userId: 'cookie-user',
    };
    requestEvent.locals.permissions = ['opportunities.read'];
    const resolve = vi.fn(async () => new Response('ok'));
    const { handle } = await import('./hooks.server');

    const response = await handle({ event: requestEvent, resolve } as never);

    expect(response.status).toBe(200);
    expect(mocks.withBearerSessionContext).not.toHaveBeenCalled();
    expect(requestEvent.locals.user).toBe(cookieUser);
    expect(requestEvent.locals.tenantId).toBe('cookie-tenant');
  });

  it('rejects an authenticated session without an active tenant role', async () => {
    const requestEvent = event();
    requestEvent.locals.user = { id: 'member-1', status: 'active' };
    requestEvent.locals.tenantId = 'tenant-1';
    requestEvent.locals.permissions = ['opportunities.read'];
    requestEvent.locals.membership = {
      id: 'membership-1',
      roleId: 'viewer-role',
      status: 'pending',
      tenantId: 'tenant-1',
      userId: 'member-1',
    };
    const resolve = vi.fn(async () => new Response('unexpected'));
    const { handle } = await import('./hooks.server');

    const response = await handle({ event: requestEvent, resolve } as never);

    expect(response.status).toBe(403);
    expect(resolve).not.toHaveBeenCalled();
  });

  it.each([
    ['/admin/opportunities'],
    ['/admin/resume-assets/resume-1/pdf'],
  ])('rejects an active non-admin cookie session from private UI surface %s', async (pathname) => {
    const requestEvent = event(null, pathname);
    requestEvent.locals.user = { id: 'member-1', status: 'active' };
    requestEvent.locals.tenantId = 'tenant-1';
    requestEvent.locals.permissions = ['opportunities.read'];
    requestEvent.locals.membership = {
      id: 'membership-1',
      roleId: 'viewer-role',
      status: 'pending',
      tenantId: 'tenant-1',
      userId: 'member-1',
    };
    const resolve = vi.fn(async () => new Response('unexpected'));
    const { handle } = await import('./hooks.server');

    const response = await handle({ event: requestEvent, resolve } as never);

    expect(response.status).toBe(403);
    expect(resolve).not.toHaveBeenCalled();
  });

  it('rejects an unauthenticated private REST request before its handler runs', async () => {
    const resolve = vi.fn(async () => new Response('unexpected'));
    const { handle } = await import('./hooks.server');

    const response = await handle({
      event: event(null, '/api/opportunities'),
      resolve,
    } as never);

    expect(response.status).toBe(401);
    expect(resolve).not.toHaveBeenCalled();
  });
});
