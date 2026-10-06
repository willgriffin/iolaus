import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  findByUserAndTenant: vi.fn(),
  get: vi.fn(),
  getTenant: vi.fn(),
  getUser: vi.fn(),
  list: vi.fn(),
  getCurrentTenant: vi.fn(),
  permissions: vi.fn(),
  privateHosted: false,
  operatorAllowed: true,
  withTenant: vi.fn(),
}));

vi.mock('@happyvertical/smrt-users', () => ({
  MembershipCollection: {
    create: vi.fn(async () => ({
      findByUserAndTenant: mocks.findByUserAndTenant,
    })),
  },
  MembershipStatus: { ACTIVE: 'active' },
  PermissionResolver: {
    create: vi.fn(async () => ({ resolvePermissions: mocks.permissions })),
  },
  TenantCollection: {
    create: vi.fn(async () => ({ get: mocks.getTenant })),
  },
  UserCollection: {
    create: vi.fn(async () => ({ get: mocks.getUser })),
  },
}));

vi.mock('@happyvertical/smrt-tenancy', () => ({
  getCurrentTenant: mocks.getCurrentTenant,
  withTenant: mocks.withTenant,
}));

vi.mock('./app-config.js', () => ({
  getAppConfig: () => ({
    runtimeProfile: mocks.privateHosted ? 'hosted' : 'local',
    workspaceMode: mocks.privateHosted ? 'private' : 'shared',
  }),
}));
vi.mock('./administrative-auth.js', () => ({
  isConfiguredOidcAdminEmail: () => mocks.operatorAllowed,
}));

vi.mock('./db.js', () => ({ getSmrtOptions: vi.fn(() => ({ db: 'test' })) }));

vi.mock('./smrt.js', () => ({
  getRequestScopedSmrtOptions: vi.fn(() => ({ db: 'test' })),
  getCollection: vi.fn(async () => ({ get: mocks.get, list: mocks.list })),
}));

import {
  getCurrentWorkspaceSubject,
  requireCandidateWorkspaceSubject,
  requireCurrentCandidateWorkspaceSubject,
  requireCurrentWorkspaceSubject,
  resolveWorkspaceSubjectForProfile,
  revalidateWorkspaceIdentity,
  verifyWorkspaceSubject,
  WorkspaceSubjectError,
  withVerifiedWorkspaceSubject,
  withWorkspaceSubjectForProfile,
} from './workspace-subject';

const locals = () => ({
  membership: {
    roleId: 'stale-role',
    status: 'active',
    tenantId: 'tenant-1',
    userId: 'user-1',
  },
  permissions: ['stale.read'],
  tenantId: 'tenant-1',
  user: { id: 'user-1' },
});

describe('workspace subject', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.privateHosted = false;
    mocks.operatorAllowed = true;
    mocks.getCurrentTenant.mockReturnValue({
      metadata: {},
      tenantId: 'tenant-1',
      userId: 'user-1',
    });
    mocks.findByUserAndTenant.mockResolvedValue({
      roleId: 'role-1',
      status: 'active',
      tenantId: 'tenant-1',
      userId: 'user-1',
    });
    mocks.getUser.mockResolvedValue({ id: 'user-1', isActive: () => true });
    mocks.getTenant.mockResolvedValue({
      id: 'tenant-1',
      isActive: () => true,
    });
    mocks.permissions.mockResolvedValue({
      permissions: new Set(['fresh.read']),
    });
    mocks.list.mockResolvedValue([
      {
        active: true,
        id: 'profile-1',
        ownerUserId: 'user-1',
        profileKey: 'default',
        tenantId: 'tenant-1',
      },
    ]);
    mocks.withTenant.mockImplementation(
      async (_context: unknown, fn: () => Promise<unknown>) => await fn(),
    );
  });

  it('re-reads an active exact membership and replaces stale permissions', async () => {
    const requestLocals = locals();

    await expect(verifyWorkspaceSubject(requestLocals)).resolves.toEqual({
      profileId: 'profile-1',
      tenantId: 'tenant-1',
      userId: 'user-1',
    });
    expect(mocks.findByUserAndTenant).toHaveBeenCalledWith(
      'user-1',
      'tenant-1',
    );
    expect(mocks.permissions).toHaveBeenCalledWith('user-1', 'tenant-1', {
      membership: expect.objectContaining({ roleId: 'role-1' }),
    });
    expect(requestLocals.permissions).toEqual(['fresh.read']);
    expect(requireCurrentWorkspaceSubject()).toEqual({
      profileId: 'profile-1',
      tenantId: 'tenant-1',
      userId: 'user-1',
    });
    expect(requireCurrentCandidateWorkspaceSubject()).toEqual({
      profileId: 'profile-1',
      tenantId: 'tenant-1',
      userId: 'user-1',
    });
  });

  it('rejects missing, inactive, or foreign memberships', async () => {
    const cases = [
      null,
      { roleId: '', status: 'active', tenantId: 'tenant-1', userId: 'user-1' },
      {
        roleId: 'role-1',
        status: 'pending',
        tenantId: 'tenant-1',
        userId: 'user-1',
      },
      {
        roleId: 'role-1',
        status: 'active',
        tenantId: 'tenant-2',
        userId: 'user-1',
      },
    ];
    for (const membership of cases) {
      mocks.findByUserAndTenant.mockResolvedValue(membership);
      const requestLocals = locals();

      await expect(verifyWorkspaceSubject(requestLocals)).resolves.toBeNull();
      expect(requestLocals.membership).toBeNull();
      expect(requestLocals.permissions).toEqual([]);
    }
  });

  it.each([
    ['inactive user', 'getUser', { id: 'user-1', isActive: () => false }],
    ['inactive tenant', 'getTenant', { id: 'tenant-1', isActive: () => false }],
  ])('rejects an %s even with an active membership', async (_label, mock, row) => {
    mocks[mock as 'getUser' | 'getTenant'].mockResolvedValue(row);
    const requestLocals = locals();

    await expect(verifyWorkspaceSubject(requestLocals)).resolves.toBeNull();
    expect(requestLocals.permissions).toEqual([]);
  });

  it('accepts a selected profile only when tenant and owner match the subject', async () => {
    const requestLocals = locals();
    await verifyWorkspaceSubject(requestLocals);
    mocks.get.mockResolvedValue({
      active: true,
      id: 'profile-1',
      ownerUserId: 'user-1',
      tenantId: 'tenant-1',
    });

    await expect(
      resolveWorkspaceSubjectForProfile('profile-1'),
    ).resolves.toEqual({
      profileId: 'profile-1',
      tenantId: 'tenant-1',
      userId: 'user-1',
    });
    expect(requireCurrentWorkspaceSubject()).toEqual({
      profileId: 'profile-1',
      tenantId: 'tenant-1',
      userId: 'user-1',
    });
    mocks.get.mockResolvedValue({
      active: true,
      id: 'profile-1',
      ownerUserId: 'user-2',
      tenantId: 'tenant-1',
    });
    await expect(
      resolveWorkspaceSubjectForProfile('profile-1'),
    ).rejects.toBeInstanceOf(WorkspaceSubjectError);
  });

  it('narrows only a subject carrying a selected profile', () => {
    expect(() =>
      requireCandidateWorkspaceSubject({
        tenantId: 'tenant-1',
        userId: 'user-1',
      }),
    ).toThrow(WorkspaceSubjectError);
    expect(
      requireCandidateWorkspaceSubject({
        profileId: 'profile-1',
        tenantId: 'tenant-1',
        userId: 'user-1',
      }),
    ).toEqual({
      profileId: 'profile-1',
      tenantId: 'tenant-1',
      userId: 'user-1',
    });
  });

  it('scopes a selected profile to one cloned context without changing siblings', async () => {
    const requestLocals = locals();
    await verifyWorkspaceSubject(requestLocals);
    const originalContext = mocks.getCurrentTenant.mock.results.at(-1)
      ?.value as {
      metadata: Record<string, unknown>;
    };
    mocks.get.mockResolvedValue({
      active: true,
      id: 'profile-alt',
      ownerUserId: 'user-1',
      tenantId: 'tenant-1',
    });

    await expect(
      resolveWorkspaceSubjectForProfile('profile-alt'),
    ).resolves.toEqual(expect.objectContaining({ profileId: 'profile-alt' }));
    expect(originalContext.metadata.workspaceSubject).toEqual(
      expect.objectContaining({ profileId: 'profile-1' }),
    );
    await expect(
      withWorkspaceSubjectForProfile('profile-alt', async (subject) => subject),
    ).resolves.toEqual(expect.objectContaining({ profileId: 'profile-alt' }));
    await expect(
      withVerifiedWorkspaceSubject(
        { profileId: 'profile-alt', tenantId: 'tenant-1', userId: 'user-1' },
        async (subject) => subject,
      ),
    ).resolves.toEqual(expect.objectContaining({ profileId: 'profile-alt' }));
    expect(mocks.withTenant).toHaveBeenCalledWith(
      expect.objectContaining({
        metadata: expect.objectContaining({
          workspaceSubject: expect.objectContaining({
            profileId: 'profile-alt',
          }),
        }),
      }),
      expect.any(Function),
    );
  });

  it('rejects a subject from a different principal context', async () => {
    mocks.getCurrentTenant.mockReturnValue({
      metadata: {},
      tenantId: 'tenant-1',
      userId: 'user-2',
    });
    await expect(
      withVerifiedWorkspaceSubject(
        { tenantId: 'tenant-1', userId: 'user-1' },
        async () => 'unexpected',
      ),
    ).rejects.toBeInstanceOf(WorkspaceSubjectError);
  });

  it.each([
    ['suspended user', 'getUser', { id: 'user-1', isActive: () => false }],
    ['inactive tenant', 'getTenant', { id: 'tenant-1', isActive: () => false }],
    ['removed membership', 'findByUserAndTenant', null],
  ])('rechecks %s when rebinding a previously verified subject', async (_label, mock, value) => {
    await verifyWorkspaceSubject(locals());
    mocks[
      mock as 'getUser' | 'getTenant' | 'findByUserAndTenant'
    ].mockResolvedValue(value);
    const callback = vi.fn(async () => 'unexpected');
    await expect(
      withVerifiedWorkspaceSubject(
        { tenantId: 'tenant-1', userId: 'user-1' },
        callback,
      ),
    ).rejects.toBeInstanceOf(WorkspaceSubjectError);
    expect(callback).not.toHaveBeenCalled();
  });

  it('denies a removed private-hosted operator at the live identity fence', async () => {
    mocks.privateHosted = true;
    mocks.operatorAllowed = false;
    await expect(
      revalidateWorkspaceIdentity({ tenantId: 'tenant-1', userId: 'user-1' }),
    ).rejects.toMatchObject({ status: 403 });
  });

  it('keeps profile authority absent when the verified owner has no default profile', async () => {
    mocks.list.mockResolvedValue([]);
    const requestLocals = locals();

    await expect(verifyWorkspaceSubject(requestLocals)).resolves.toEqual({
      tenantId: 'tenant-1',
      userId: 'user-1',
    });
  });

  it('keeps profile authority absent for inactive or duplicate default profiles', async () => {
    mocks.list.mockResolvedValue([
      {
        active: false,
        id: 'profile-1',
        ownerUserId: 'user-1',
        profileKey: 'default',
        tenantId: 'tenant-1',
      },
    ]);
    await expect(verifyWorkspaceSubject(locals())).resolves.toEqual({
      tenantId: 'tenant-1',
      userId: 'user-1',
    });
    mocks.list.mockResolvedValue([
      {
        active: true,
        id: 'profile-1',
        ownerUserId: 'user-1',
        profileKey: 'default',
        tenantId: 'tenant-1',
      },
      {
        active: true,
        id: 'profile-2',
        ownerUserId: 'user-1',
        profileKey: 'default',
        tenantId: 'tenant-1',
      },
    ]);
    await expect(verifyWorkspaceSubject(locals())).resolves.toEqual({
      tenantId: 'tenant-1',
      userId: 'user-1',
    });
  });

  it('does not synthesize a workspace subject outside verified SMRT context', () => {
    mocks.getCurrentTenant.mockReturnValue(undefined);
    expect(getCurrentWorkspaceSubject()).toBeNull();
    expect(() => requireCurrentWorkspaceSubject()).toThrow(
      WorkspaceSubjectError,
    );
  });
});
