import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { POST } from './+server';

const routeMocks = vi.hoisted(() => {
  class MockMcpAccessError extends Error {
    constructor(
      readonly status: number,
      message: string,
    ) {
      super(message);
      this.name = 'McpAccessError';
    }
  }

  return {
    callMcpTool: vi.fn(async () => ({
      content: [{ text: '{}', type: 'text' }],
    })),
    isPublicMcpTool: vi.fn(() => false),
    McpAccessError: MockMcpAccessError,
  };
});

vi.mock('$lib/server/mcp', () => ({
  callMcpTool: routeMocks.callMcpTool,
  isPublicMcpTool: routeMocks.isPublicMcpTool,
  McpAccessError: routeMocks.McpAccessError,
}));

const ownerLocals = {
  membership: {
    roleId: 'admin-role',
    status: 'active',
    tenantId: 'tenant-1',
    userId: 'user-1',
  },
  permissions: ['sources.update'],
  tenantId: 'tenant-1',
  user: { id: 'user-1', status: 'active' },
};

const environmentNames = [
  'IOLAUS_OIDC_ADMIN_EMAILS',
  'IOLAUS_OIDC_CLIENT_ID',
  'IOLAUS_OIDC_REALM',
  'IOLAUS_OIDC_SERVER_URL',
  'IOLAUS_PUBLIC_URL',
  'SMRT_APP_ID',
  'SMRT_RUNTIME_PROFILE',
] as const;
const originalEnvironment = Object.fromEntries(
  environmentNames.map((name) => [name, process.env[name]]),
);

function hostedEnvironment() {
  Object.assign(process.env, {
    IOLAUS_OIDC_ADMIN_EMAILS: 'current-owner@example.invalid',
    IOLAUS_OIDC_CLIENT_ID: 'iolaus-self-hosted',
    IOLAUS_OIDC_REALM: 'career',
    IOLAUS_OIDC_SERVER_URL: 'https://identity.example.invalid',
    IOLAUS_PUBLIC_URL: 'https://iolaus.example.invalid',
    SMRT_APP_ID: 'iolaus-career',
    SMRT_RUNTIME_PROFILE: 'self-hosted',
  });
}

function jsonRequest(payload: unknown): Request {
  return new Request('https://iolaus.localhost/api/mcp/call', {
    body: JSON.stringify(payload),
    method: 'POST',
  });
}

function rawRequest(body: string): Request {
  return new Request('https://iolaus.localhost/api/mcp/call', {
    body,
    method: 'POST',
  });
}

describe('/api/mcp/call', () => {
  beforeEach(() => {
    routeMocks.callMcpTool.mockClear();
    routeMocks.isPublicMcpTool.mockReset();
    routeMocks.isPublicMcpTool.mockReturnValue(false);
  });

  afterEach(() => {
    for (const name of environmentNames) {
      const original = originalEnvironment[name];
      if (original === undefined) delete process.env[name];
      else process.env[name] = original;
    }
  });

  it('rejects non-object request bodies before calling MCP tools', async () => {
    const response = await POST({
      locals: {},
      request: jsonRequest(null),
    } as never);

    await expect(response.json()).resolves.toEqual({
      error: 'Request body must be a JSON object.',
    });
    expect(response.status).toBe(400);
    expect(routeMocks.callMcpTool).not.toHaveBeenCalled();
  });

  it('maps malformed JSON to a bad request before calling MCP tools', async () => {
    const response = await POST({
      locals: {},
      request: rawRequest('{"name":'),
    } as never);

    await expect(response.json()).resolves.toEqual({
      error: 'Request body must be valid JSON.',
    });
    expect(response.status).toBe(400);
    expect(routeMocks.callMcpTool).not.toHaveBeenCalled();
  });

  it('maps MCP access errors from tool calls to JSON responses', async () => {
    routeMocks.callMcpTool.mockRejectedValueOnce(
      new routeMocks.McpAccessError(
        400,
        'MCP tool arguments must be a JSON object.',
      ),
    );

    const response = await POST({
      locals: ownerLocals,
      request: jsonRequest({ arguments: [], name: 'source_update' }),
    } as never);

    await expect(response.json()).resolves.toEqual({
      error: 'MCP tool arguments must be a JSON object.',
    });
    expect(response.status).toBe(400);
    expect(routeMocks.callMcpTool).toHaveBeenCalledWith({
      arguments: [],
      name: 'source_update',
      permissions: ['sources.update'],
      tenantId: 'tenant-1',
      user: ownerLocals.user,
    });
  });

  it.each([
    ['unauthenticated', {}, 401, 'Unauthorized'],
    [
      'authenticated non-admin',
      {
        ...ownerLocals,
        membership: { ...ownerLocals.membership, status: 'pending' },
      },
      403,
      'Forbidden',
    ],
  ])('rejects a %s caller who guesses a private MCP tool name', async (_name, locals, status, error) => {
    const response = await POST({
      locals,
      request: jsonRequest({ arguments: {}, name: 'source_update' }),
    } as never);

    expect(response.status).toBe(status);
    await expect(response.json()).resolves.toEqual({ error });
    expect(routeMocks.callMcpTool).not.toHaveBeenCalled();
  });

  it('revokes a previously authorized hosted session after its email leaves the allowlist', async () => {
    hostedEnvironment();
    const response = await POST({
      locals: {
        ...ownerLocals,
        user: {
          ...ownerLocals.user,
          email: 'removed-owner@example.invalid',
        },
      },
      request: jsonRequest({ arguments: {}, name: 'source_update' }),
    } as never);

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({ error: 'Forbidden' });
    expect(routeMocks.callMcpTool).not.toHaveBeenCalled();
  });
});
