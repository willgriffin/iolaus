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

function event(token = 'terminal-token'): {
  cookies: { get: ReturnType<typeof vi.fn> };
  locals: {
    membership: { id: string } | null;
    permissions: string[];
    sessionId: string | null;
    tenantId: string | null;
    user: { id: string } | null;
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
    request: new Request('https://iolaus.localhost/api/job-search/browse', {
      headers: { authorization: `Bearer ${token}` },
    }),
    url: new URL('https://iolaus.localhost/api/job-search/browse'),
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
    const membership = { id: 'membership-1' };
    const user = { id: 'user-1' };
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
    const cookieUser = { id: 'cookie-user' };
    requestEvent.locals.user = cookieUser;
    requestEvent.locals.tenantId = 'cookie-tenant';
    const resolve = vi.fn(async () => new Response('ok'));
    const { handle } = await import('./hooks.server');

    const response = await handle({ event: requestEvent, resolve } as never);

    expect(response.status).toBe(200);
    expect(mocks.withBearerSessionContext).not.toHaveBeenCalled();
    expect(requestEvent.locals.user).toBe(cookieUser);
    expect(requestEvent.locals.tenantId).toBe('cookie-tenant');
  });
});
