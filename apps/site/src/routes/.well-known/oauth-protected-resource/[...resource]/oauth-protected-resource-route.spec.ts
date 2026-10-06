import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  auth: vi.fn(),
}));

vi.mock('$lib/server/mcp-oauth', () => ({
  createIolausMcpResourceAuth: mocks.auth,
}));

function event(pathname: string) {
  return { url: new URL(`https://jobs.example.com${pathname}`) } as never;
}

describe('OAuth protected-resource discovery', () => {
  beforeEach(() => {
    mocks.auth.mockReset();
  });

  it('does not publish discovery while optional OAuth is incomplete', async () => {
    mocks.auth.mockReturnValue(null);
    const { GET } = await import('./+server');

    expect(
      GET(event('/.well-known/oauth-protected-resource/api/mcp')),
    ).toMatchObject({
      status: 404,
    });
  });

  it('serves only the configured MCP protected-resource path', async () => {
    const metadata = new Response(
      JSON.stringify({ resource: 'https://jobs.example.com/api/mcp' }),
      {
        headers: {
          'cache-control': 'no-store',
          'content-type': 'application/json',
        },
      },
    );
    mocks.auth.mockReturnValue({
      metadataResponse: vi.fn(() => metadata),
      metadataUrl:
        'https://jobs.example.com/.well-known/oauth-protected-resource/api/mcp',
    });
    const { GET } = await import('./+server');

    expect(GET(event('/.well-known/oauth-protected-resource/api/mcp'))).toBe(
      metadata,
    );
    expect(
      GET(event('/.well-known/oauth-protected-resource/api/other')),
    ).toMatchObject({
      status: 404,
    });
  });
});
