import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  canonicalPost: vi.fn(),
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
