import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createMcpOauthPrincipalResolver } from './mcp-oauth';

const mocks = vi.hoisted(() => ({
  query: vi.fn(),
  resolveDatabase: vi.fn(),
}));

const environmentNames = [
  'IOLAUS_WORKSPACE_MODE',
  'SMRT_APP_ID',
  'SMRT_RUNTIME_PROFILE',
] as const;
const originalEnvironment = Object.fromEntries(
  environmentNames.map((name) => [name, process.env[name]]),
);

describe('OAuth MCP principal mapping', () => {
  beforeEach(() => {
    mocks.query.mockReset();
    mocks.resolveDatabase.mockReset();
    Object.assign(process.env, {
      IOLAUS_WORKSPACE_MODE: 'shared',
      SMRT_APP_ID: 'iolaus-test',
      SMRT_RUNTIME_PROFILE: 'self-hosted',
    });
  });

  afterEach(() => {
    for (const name of environmentNames) {
      const value = originalEnvironment[name];
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });

  it('maps only an exact existing issuer/subject identity and live membership', async () => {
    mocks.query
      .mockResolvedValueOnce({
        rows: [{ id: 'user-1', profile_id: 'profile-1', status: 'active' }],
      })
      .mockResolvedValueOnce({
        rows: [
          {
            role_id: 'member',
            status: 'active',
            tenant_id: 'tenant-1',
            tenant_status: 'active',
          },
        ],
      });
    mocks.resolveDatabase.mockResolvedValue({ query: mocks.query });
    const resolveMcpOauthPrincipal = createMcpOauthPrincipalResolver({
      resolveDatabase: mocks.resolveDatabase,
    });

    await expect(
      resolveMcpOauthPrincipal({
        claims: {
          email: 'attacker@example.invalid',
          tenant_id: 'tenant-attacker',
        },
        issuer: 'https://identity.example.com/realms/career',
        scopes: ['iolaus.mcp'],
        subject: 'oidc-subject-1',
      }),
    ).resolves.toEqual({ id: 'user-1', tenantId: 'tenant-1' });

    expect(mocks.query).toHaveBeenNthCalledWith(
      1,
      expect.stringContaining('oidc_identities.issuer = ?'),
      ['https://identity.example.com/realms/career', 'oidc-subject-1'],
    );
    expect(mocks.query).toHaveBeenNthCalledWith(
      2,
      expect.stringContaining('memberships.user_id = ?'),
      ['user-1'],
    );
  });

  it('rejects a mapped shared user with ambiguous active tenant memberships', async () => {
    mocks.query
      .mockResolvedValueOnce({
        rows: [{ id: 'user-1', profile_id: 'profile-1', status: 'active' }],
      })
      .mockResolvedValueOnce({
        rows: [
          {
            role_id: 'member',
            status: 'active',
            tenant_id: 'tenant-1',
            tenant_status: 'active',
          },
          {
            role_id: 'member',
            status: 'active',
            tenant_id: 'tenant-2',
            tenant_status: 'active',
          },
        ],
      });
    mocks.resolveDatabase.mockResolvedValue({ query: mocks.query });
    const resolveMcpOauthPrincipal = createMcpOauthPrincipalResolver({
      resolveDatabase: mocks.resolveDatabase,
    });

    await expect(
      resolveMcpOauthPrincipal({
        claims: {},
        issuer: 'https://identity.example.com/realms/career',
        scopes: ['iolaus.mcp'],
        subject: 'oidc-subject-1',
      }),
    ).resolves.toBeNull();
  });

  it('selects the configured private installation tenant, never a first row', async () => {
    process.env.IOLAUS_WORKSPACE_MODE = 'private';
    mocks.query
      .mockResolvedValueOnce({
        rows: [{ id: 'user-1', profile_id: 'profile-1', status: 'active' }],
      })
      .mockResolvedValueOnce({
        rows: [
          {
            role_id: 'member',
            status: 'active',
            tenant_id: 'tenant-private',
            tenant_slug: 'iolaus-test',
            tenant_status: 'active',
          },
        ],
      });
    mocks.resolveDatabase.mockResolvedValue({ query: mocks.query });
    const resolveMcpOauthPrincipal = createMcpOauthPrincipalResolver({
      resolveDatabase: mocks.resolveDatabase,
    });

    await expect(
      resolveMcpOauthPrincipal({
        claims: {},
        issuer: 'https://identity.example.com/realms/career',
        scopes: ['iolaus.mcp'],
        subject: 'oidc-subject-1',
      }),
    ).resolves.toEqual({ id: 'user-1', tenantId: 'tenant-private' });
    expect(mocks.query).toHaveBeenNthCalledWith(
      2,
      expect.stringContaining('AND tenants.slug = ?'),
      ['user-1', 'iolaus-test'],
    );
  });
});
