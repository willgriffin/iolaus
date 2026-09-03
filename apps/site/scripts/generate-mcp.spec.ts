import { afterEach, describe, expect, it, vi } from 'vitest';

const mcpMocks = vi.hoisted(() => ({
  generateServer: vi.fn(async () => {}),
  options: undefined as
    | {
        description: string;
        name: string;
        version: string;
      }
    | undefined,
}));

vi.mock('@happyvertical/smrt-core/generators/mcp', () => ({
  MCPGenerator: class {
    constructor(options: NonNullable<typeof mcpMocks.options>) {
      mcpMocks.options = options;
    }

    generateServer = mcpMocks.generateServer;
  },
}));

vi.mock('../src/lib/objects/index.js', () => ({}));
vi.mock('../src/lib/server/db.js', () => ({
  getDbConfig: vi.fn(() => ({ db: ':memory:' })),
}));

afterEach(() => {
  mcpMocks.generateServer.mockClear();
  mcpMocks.options = undefined;
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe('generate-mcp', () => {
  it('uses the configured app ID for generated MCP identity', async () => {
    vi.stubEnv('SMRT_APP_ID', 'career-hub');

    await import('./generate-mcp.js');

    expect(mcpMocks.options).toMatchObject({
      name: 'career-hub-employment-search',
    });
    expect(mcpMocks.generateServer).toHaveBeenCalledWith(
      expect.objectContaining({ serverName: 'career-hub-employment-search' }),
    );
  });
});
