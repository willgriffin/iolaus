import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

const environmentNames = [
  'DATABASE_URL',
  'IOLAUS_OIDC_ADMIN_EMAILS',
  'IOLAUS_OIDC_CLIENT_ID',
  'IOLAUS_OIDC_REALM',
  'IOLAUS_OIDC_SERVER_URL',
  'IOLAUS_PUBLIC_URL',
  'IOLAUS_WORKSPACE_MODE',
  'SMRT_APP_ID',
  'SMRT_RUNTIME_PROFILE',
] as const;
const originalEnvironment = Object.fromEntries(
  environmentNames.map((name) => [name, process.env[name]]),
);

const mocks = vi.hoisted(() => ({
  candidateProfileOnboardingRedirect: vi.fn((): string | null => null),
  contextActive: false,
  ensureApplicationRuntimeReady: vi.fn(),
  verifyWorkspaceSubject: vi.fn(),
  withBearerSessionContext: vi.fn(),
}));

vi.mock('$lib/server/skill-vocabulary', () => ({
  refreshSkillVocabularyLookup: vi.fn(async () => undefined),
}));

vi.mock('$lib/server/local-oauth', () => ({
  getLocalOAuth: vi.fn(async () => null),
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

vi.mock('$lib/server/workspace-subject', () => ({
  candidateProfileOnboardingRedirect: mocks.candidateProfileOnboardingRedirect,
  verifyWorkspaceSubject: mocks.verifyWorkspaceSubject,
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
    user: { email?: string; id: string; status?: string } | null;
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
    Object.assign(process.env, {
      DATABASE_URL: 'postgresql://localhost/iolaus_tests_hooks_test',
      IOLAUS_OIDC_ADMIN_EMAILS: 'owner@example.invalid',
      IOLAUS_OIDC_CLIENT_ID: 'iolaus-tests',
      IOLAUS_OIDC_REALM: 'iolaus',
      IOLAUS_OIDC_SERVER_URL: 'https://identity.example.invalid',
      IOLAUS_PUBLIC_URL: 'https://iolaus.example.invalid',
      IOLAUS_WORKSPACE_MODE: 'private',
      SMRT_APP_ID: 'iolaus-tests',
      SMRT_RUNTIME_PROFILE: 'self-hosted',
    });
    vi.clearAllMocks();
    mocks.contextActive = false;
    mocks.ensureApplicationRuntimeReady.mockResolvedValue(undefined);
    mocks.verifyWorkspaceSubject.mockResolvedValue(null);
  });

  it('bypasses sessions and workspace resolution only for public profile JSON', async () => {
    const { handle } = await import('./hooks.server');
    for (const pathname of [
      '/api/public/v1/profiles/avery-example',
      '/api/public/v1/profiles/invalid!',
    ]) {
      const requestEvent = event(null, pathname);
      requestEvent.request.headers.set('authorization', 'broken credential');
      const resolve = vi.fn(
        async () =>
          new Response('public', {
            headers: {
              'set-cookie': 'session=extended',
              'access-control-allow-credentials': 'true',
            },
          }),
      );
      const response = await handle({ event: requestEvent, resolve } as never);
      expect(response.status).toBe(200);
      expect(response.headers.get('cache-control')).toBe('no-store');
      expect(response.headers.get('access-control-allow-origin')).toBe('*');
      expect(response.headers.has('set-cookie')).toBe(false);
      expect(response.headers.has('access-control-allow-credentials')).toBe(
        false,
      );
    }
    expect(mocks.verifyWorkspaceSubject).not.toHaveBeenCalled();
    expect(mocks.withBearerSessionContext).not.toHaveBeenCalled();
    for (const pathname of [
      '/admin',
      '/api/public/v1/me/matches',
      '/api/job-search/browse',
      '/api/public/v1/profiles/avery-example/private',
    ]) {
      const requestEvent = event(null, pathname);
      requestEvent.request.headers.set('authorization', 'broken credential');
      const resolve = vi.fn();
      expect(
        (await handle({ event: requestEvent, resolve } as never)).status,
      ).toBe(401);
      expect(resolve).not.toHaveBeenCalled();
    }
  });

  it('bounds public hook failures and unsupported methods with anonymous transport', async () => {
    const { handle } = await import('./hooks.server');
    for (const method of ['GET', 'HEAD']) {
      const requestEvent = event(null, '/api/public/v1/profiles/avery-example');
      requestEvent.request = new Request(requestEvent.url, { method });
      const response = await handle({
        event: requestEvent,
        resolve: async () => {
          throw new Error('private configuration failure');
        },
      } as never);
      expect(response.status).toBe(503);
      expect(response.headers.get('cache-control')).toBe('no-store');
      expect(response.headers.get('access-control-allow-origin')).toBe('*');
      if (method === 'HEAD') expect(await response.text()).toBe('');
      else
        expect((await response.json()).error.code).toBe(
          'PROFILE_SERVICE_UNAVAILABLE',
        );
    }
    const requestEvent = event(null, '/api/public/v1/profiles/avery-example');
    requestEvent.request = new Request(requestEvent.url, { method: 'POST' });
    const resolve = vi.fn();
    const response = await handle({ event: requestEvent, resolve } as never);
    expect(response.status).toBe(405);
    expect(response.headers.get('allow')).toBe('GET, HEAD, OPTIONS');
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.get('access-control-allow-origin')).toBe('*');
    expect(resolve).not.toHaveBeenCalled();
  });

  it('admits the profile assistant anonymously for POST/OPTIONS only and strips credentials', async () => {
    const { handle } = await import('./hooks.server');
    for (const pathname of [
      '/api/public/v1/profiles/avery-example/chat',
      '/api/public/v1/profiles/avery-example/voice',
    ]) {
      const requestEvent = event(null, pathname);
      requestEvent.request = new Request(requestEvent.url, {
        method: 'POST',
        headers: { authorization: 'broken credential' },
      });
      const resolve = vi.fn(
        async () =>
          new Response('data: {}\n\n', {
            headers: {
              'set-cookie': 'session=extended',
              'access-control-allow-credentials': 'true',
            },
          }),
      );
      const response = await handle({ event: requestEvent, resolve } as never);
      expect(response.status).toBe(200);
      expect(response.headers.get('cache-control')).toBe('no-store');
      expect(response.headers.has('set-cookie')).toBe(false);
      expect(response.headers.has('access-control-allow-credentials')).toBe(
        false,
      );
      // The route decides CORS from its allowlist; the hook never widens it.
      expect(response.headers.has('access-control-allow-origin')).toBe(false);
    }
    expect(mocks.verifyWorkspaceSubject).not.toHaveBeenCalled();
    expect(mocks.withBearerSessionContext).not.toHaveBeenCalled();
    const requestEvent = event(
      null,
      '/api/public/v1/profiles/avery-example/chat',
    );
    requestEvent.request = new Request(requestEvent.url, { method: 'GET' });
    const resolve = vi.fn();
    const response = await handle({ event: requestEvent, resolve } as never);
    expect(response.status).toBe(405);
    expect(response.headers.get('allow')).toBe('POST, OPTIONS');
    expect(resolve).not.toHaveBeenCalled();
    const failing = event(null, '/api/public/v1/profiles/avery-example/voice');
    failing.request = new Request(failing.url, { method: 'POST' });
    const failed = await handle({
      event: failing,
      resolve: async () => {
        throw new Error('private configuration failure');
      },
    } as never);
    expect(failed.status).toBe(503);
    expect((await failed.json()).error.code).toBe('ASSISTANT_UNAVAILABLE');
  });

  afterAll(() => {
    for (const name of environmentNames) {
      const original = originalEnvironment[name];
      if (original === undefined) delete process.env[name];
      else process.env[name] = original;
    }
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
    await vi.waitFor(() =>
      expect(startPublishedResumePrime).toHaveBeenCalledOnce(),
    );
  });

  it('keeps anonymous private-match authentication errors out of shared caches', async () => {
    const resolve = vi.fn(async () => new Response('unexpected'));
    const { handle } = await import('./hooks.server');
    const response = await handle({
      event: event(null, '/api/public/v1/me/matches'),
      resolve,
    } as never);
    expect(response.status).toBe(401);
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    expect(resolve).not.toHaveBeenCalled();
  });

  it('resolves protected APIs inside the bearer tenant and database context', async () => {
    const membership = {
      id: 'membership-1',
      roleId: 'admin-role',
      status: 'active',
      tenantId: 'tenant-1',
      userId: 'user-1',
    };
    const user = {
      email: 'owner@example.invalid',
      id: 'user-1',
      status: 'active',
    };
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
    expect(mocks.verifyWorkspaceSubject).toHaveBeenCalledWith(
      requestEvent.locals,
    );
    expect(resolve).toHaveBeenCalledOnce();
  });

  it('leaves a JWT-shaped MCP bearer for canonical resource authentication', async () => {
    const requestEvent = event('header.payload.signature', '/api/mcp');
    const resolve = vi.fn(async () => new Response('oauth-route'));
    const { handle } = await import('./hooks.server');

    const response = await handle({ event: requestEvent, resolve } as never);

    expect(response.status).toBe(200);
    expect(mocks.withBearerSessionContext).not.toHaveBeenCalled();
    expect(mocks.verifyWorkspaceSubject).toHaveBeenCalledWith(
      requestEvent.locals,
    );
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

  it('rejects invalid explicit credentials even when a cookie session exists', async () => {
    const requestEvent = event('different-bearer');
    const cookieUser = {
      email: 'owner@example.invalid',
      id: 'cookie-user',
      status: 'active',
    };
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

    expect(response.status).toBe(401);
    expect(mocks.withBearerSessionContext).toHaveBeenCalled();
    expect(resolve).not.toHaveBeenCalled();
    expect(requestEvent.locals.user).toBe(cookieUser);
    expect(requestEvent.locals.tenantId).toBe('cookie-tenant');
  });

  it('rejects an authenticated session without an active tenant role', async () => {
    const requestEvent = event(null);
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

  it('rejects a stale cookie permission snapshot after workspace verification revokes membership', async () => {
    const requestEvent = event(null);
    requestEvent.locals.user = {
      email: 'owner@example.invalid',
      id: 'user-1',
      status: 'active',
    };
    requestEvent.locals.tenantId = 'tenant-1';
    requestEvent.locals.membership = {
      id: 'membership-1',
      roleId: 'admin-role',
      status: 'active',
      tenantId: 'tenant-1',
      userId: 'user-1',
    };
    requestEvent.locals.permissions = ['opportunities.read'];
    mocks.verifyWorkspaceSubject.mockImplementation(async (locals) => {
      locals.membership = null;
      locals.permissions = [];
      return null;
    });
    const resolve = vi.fn(async () => new Response('unexpected'));
    const { handle } = await import('./hooks.server');

    const response = await handle({ event: requestEvent, resolve } as never);

    expect(response.status).toBe(403);
    expect(mocks.verifyWorkspaceSubject).toHaveBeenCalledWith(
      requestEvent.locals,
    );
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
      status: 'active',
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

  it('sends an authorized hosted user without a candidate profile to onboarding, not a 500', async () => {
    const requestEvent = event(null, '/admin');
    requestEvent.locals.user = {
      email: 'owner@example.invalid',
      id: 'owner-1',
      status: 'active',
    };
    requestEvent.locals.tenantId = 'tenant-1';
    requestEvent.locals.permissions = ['opportunities.read'];
    requestEvent.locals.membership = {
      id: 'membership-1',
      roleId: 'admin-role',
      status: 'active',
      tenantId: 'tenant-1',
      userId: 'owner-1',
    };
    mocks.candidateProfileOnboardingRedirect.mockReturnValueOnce(
      '/admin/onboarding',
    );
    const resolve = vi.fn(async () => new Response('unexpected'));
    const { handle } = await import('./hooks.server');
    let outcome: unknown = null;
    try {
      await handle({ event: requestEvent, resolve } as never);
    } catch (thrown) {
      outcome = thrown;
    }
    expect(outcome).toMatchObject({
      location: '/admin/onboarding',
      status: 303,
    });
    expect(resolve).not.toHaveBeenCalled();
  });
});
