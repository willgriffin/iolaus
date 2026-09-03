import { beforeEach, describe, expect, it, vi } from 'vitest';
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
    McpAccessError: MockMcpAccessError,
  };
});

vi.mock('$lib/server/mcp', () => ({
  callMcpTool: routeMocks.callMcpTool,
  McpAccessError: routeMocks.McpAccessError,
}));

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
      locals: { user: { id: 'user-1' } },
      request: jsonRequest({ arguments: [], name: 'source_update' }),
    } as never);

    await expect(response.json()).resolves.toEqual({
      error: 'MCP tool arguments must be a JSON object.',
    });
    expect(response.status).toBe(400);
    expect(routeMocks.callMcpTool).toHaveBeenCalledWith({
      arguments: [],
      name: 'source_update',
      permissions: undefined,
      tenantId: undefined,
      user: { id: 'user-1' },
    });
  });
});
