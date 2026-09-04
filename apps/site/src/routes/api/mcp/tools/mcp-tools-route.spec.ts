import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  listMcpTools: vi.fn(),
}));

vi.mock('$lib/server/mcp', () => ({
  listMcpTools: mocks.listMcpTools,
}));

const ownerLocals = {
  membership: {
    roleId: 'admin-role',
    status: 'active',
    tenantId: 'tenant-1',
    userId: 'user-1',
  },
  permissions: ['opportunities.read'],
  tenantId: 'tenant-1',
  user: { id: 'user-1', status: 'active' },
};

describe('MCP tool inventory authorization', () => {
  beforeEach(() => {
    mocks.listMcpTools.mockReset();
    mocks.listMcpTools.mockResolvedValue([]);
  });

  it.each([
    ['unauthenticated client', {}, false],
    [
      'authenticated client without an active membership',
      {
        ...ownerLocals,
        membership: { ...ownerLocals.membership, status: 'pending' },
      },
      false,
    ],
    ['active local owner', ownerLocals, true],
  ])('uses the correct inventory visibility for a %s', async (_name, locals, authenticated) => {
    const { GET } = await import('./+server');

    const response = await GET({ locals } as never);

    expect(response.status).toBe(200);
    expect(mocks.listMcpTools).toHaveBeenCalledWith({ authenticated });
  });
});
