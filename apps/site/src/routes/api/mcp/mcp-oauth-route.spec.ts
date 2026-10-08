import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./tools/+server', () => ({ GET: vi.fn() }));

vi.mock('$lib/server/local-oauth', () => ({
  getLocalOAuth: () => mocks.localOAuth(),
  oauthFailure: () => new Response(null, { status: 401 }),
}));
vi.mock('$lib/server/workspace-subject', () => ({
  verifyWorkspaceSubject: async (locals: Record<string, unknown>) => {
    locals.permissions = [
      'workflow.application.inspect',
      'workflow.application.prepare',
    ];
    return { userId: 'user', tenantId: 'tenant' };
  },
}));
vi.mock('@happyvertical/smrt-users', () => ({
  withPrincipalPermissionContext: async (
    _options: unknown,
    execute: () => Promise<unknown>,
  ) => execute(),
}));
vi.mock('$lib/server/db', () => ({ getSmrtOptions: () => ({}) }));

const mocks = vi.hoisted(() => ({
  canonicalPost: vi.fn(),
  localOAuth: vi.fn(async (): Promise<unknown> => null),
  resourceAuth: vi.fn(),
  withMcpOauthContext: vi.fn(),
}));

vi.mock('@happyvertical/smrt-app-mcp/sveltekit', () => ({
  mountMcpRoute: vi.fn(() => mocks.canonicalPost),
}));

vi.mock('$lib/server/mcp-app-server', () => ({
  mcpAppServer: {},
  resolveMcpAppPrincipal: vi.fn(),
}));

vi.mock('$lib/server/mcp-oauth', () => ({
  createIolausMcpResourceAuth: mocks.resourceAuth,
  isMcpOauthBearerRequest: (request: Request) =>
    /^Bearer +[^. ]+\.[^. ]+\.[^. ]+$/u.test(
      request.headers.get('authorization') ?? '',
    ),
  withMcpOauthContext: mocks.withMcpOauthContext,
}));

function event(request: Request) {
  return {
    locals: {},
    request,
    url: new URL('https://jobs.example.com/api/mcp'),
  } as never;
}

describe('canonical MCP OAuth boundary', () => {
  beforeEach(() => {
    mocks.localOAuth.mockReset().mockResolvedValue(null);
    mocks.canonicalPost.mockReset();
    mocks.resourceAuth.mockReset();
    mocks.withMcpOauthContext.mockReset();
    mocks.canonicalPost.mockResolvedValue(new Response('legacy'));
    mocks.resourceAuth.mockReturnValue(null);
  });

  it('keeps opaque terminal Bearers on the established authenticated transport', async () => {
    const { POST } = await import('./+server');

    const response = await POST(
      event(
        new Request('https://jobs.example.com/api/mcp', {
          headers: { authorization: 'Bearer terminal-session-id' },
          method: 'POST',
        }),
      ),
    );

    expect(response.status).toBe(200);
    expect(mocks.canonicalPost).toHaveBeenCalledOnce();
    expect(mocks.withMcpOauthContext).not.toHaveBeenCalled();
  });

  it('returns the protected-resource challenge before MCP dispatch for a rejected JWT', async () => {
    const response = new Response(null, {
      headers: {
        'www-authenticate':
          'Bearer resource_metadata="https://jobs.example.com/.well-known/oauth-protected-resource/api/mcp"',
      },
      status: 401,
    });
    mocks.resourceAuth.mockReturnValue({
      authenticate: vi.fn(async () => ({ ok: false, response })),
    });
    const { POST } = await import('./+server');

    await expect(
      POST(
        event(
          new Request('https://jobs.example.com/api/mcp', {
            headers: { authorization: 'Bearer one.two.three' },
            method: 'POST',
          }),
        ),
      ),
    ).resolves.toBe(response);

    expect(mocks.canonicalPost).not.toHaveBeenCalled();
  });

  it('builds the server context from an accepted resource principal before dispatch', async () => {
    const authenticated = {
      ok: true as const,
      principal: { id: 'user-1', tenantId: 'tenant-1' },
    };
    mocks.resourceAuth.mockReturnValue({
      authenticate: vi.fn(async () => authenticated),
    });
    mocks.withMcpOauthContext.mockResolvedValue(new Response('oauth'));
    const { POST } = await import('./+server');

    const response = await POST(
      event(
        new Request('https://jobs.example.com/api/mcp', {
          headers: { authorization: 'Bearer one.two.three' },
          method: 'POST',
        }),
      ),
    );

    expect(await response.text()).toBe('oauth');
    expect(mocks.withMcpOauthContext).toHaveBeenCalledWith(
      expect.anything(),
      authenticated.principal,
      mocks.canonicalPost,
    );
    expect(mocks.canonicalPost).not.toHaveBeenCalled();
  });
});

describe('local issuer MCP authority', () => {
  const token = `${Buffer.from(JSON.stringify({ alg: 'ES256', typ: 'at+jwt' })).toString('base64url')}.e30.signature`;
  it.each([
    'GET',
    'POST',
  ] as const)('rejects a JWT on %s when no verifier is configured', async (method) => {
    mocks.localOAuth.mockResolvedValue(null);
    mocks.resourceAuth.mockReturnValue(null);
    mocks.canonicalPost.mockClear();
    const route = await import('./+server');
    expect(
      (
        await route[method](
          event(
            new Request('https://jobs.example.com/api/mcp', {
              method,
              headers: { authorization: `Bearer ${token}` },
            }),
          ),
        )
      ).status,
    ).toBe(401);
    expect(mocks.canonicalPost).not.toHaveBeenCalled();
  });
  it('re-intersects fresh permissions with live grant scopes before dispatch', async () => {
    const validateAccessTokenClaims = vi.fn(async () => ({
      user: { id: 'user' },
      tenantId: 'tenant',
      membership: {},
      permissions: ['workflow.application.inspect'],
    }));
    const verifyAccessToken = vi.fn(async () => ({
      exp: 9999999999,
      iat: 1,
      sub: 'user',
      scope: 'opportunities:read',
      client_id: 'client',
    }));
    mocks.localOAuth.mockResolvedValue({
      resource: 'https://jobs.example.com/api/mcp',
      server: { verifyAccessToken },
      authorization: { validateAccessTokenClaims },
    });
    mocks.canonicalPost.mockClear().mockResolvedValue(new Response('local'));
    const { POST } = await import('./+server');
    expect(
      (
        await POST(
          event(
            new Request('https://jobs.example.com/api/mcp', {
              method: 'POST',
              headers: { authorization: `Bearer ${token}` },
            }),
          ),
        )
      ).status,
    ).toBe(200);
    expect(verifyAccessToken).toHaveBeenCalledWith(
      token,
      'https://jobs.example.com/api/mcp',
    );
    expect(mocks.canonicalPost.mock.calls[0][0].locals.permissions).toEqual([
      'workflow.application.inspect',
    ]);
    validateAccessTokenClaims.mockResolvedValueOnce(null as never);
    mocks.canonicalPost.mockClear();
    expect(
      (
        await POST(
          event(
            new Request('https://jobs.example.com/api/mcp', {
              method: 'POST',
              headers: { authorization: `Bearer ${token}` },
            }),
          ),
        )
      ).status,
    ).toBe(401);
    expect(mocks.canonicalPost).not.toHaveBeenCalled();
  });
});
