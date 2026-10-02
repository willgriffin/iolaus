import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  findByUserAndTenant: vi.fn(),
  get: vi.fn(),
  list: vi.fn(),
  getCurrentTenant: vi.fn(),
  permissions: vi.fn(),
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
}));

vi.mock('@happyvertical/smrt-tenancy', () => ({
  getCurrentTenant: mocks.getCurrentTenant,
}));

vi.mock('./db.js', () => ({ getSmrtOptions: vi.fn(() => ({ db: 'test' })) }));

vi.mock('./smrt.js', () => ({
  getCollection: vi.fn(async () => ({ get: mocks.get, list: mocks.list })),
}));

import {
  getCurrentWorkspaceSubject,
  requireCurrentWorkspaceSubject,
  resolveWorkspaceSubjectForProfile,
  verifyWorkspaceSubject,
  WorkspaceSubjectError,
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
    mocks.permissions.mockResolvedValue({
      permissions: new Set(['fresh.read']),
    });
    mocks.list.mockResolvedValue([
      {
        id: 'profile-1',
        ownerUserId: 'user-1',
        profileKey: 'default',
        tenantId: 'tenant-1',
      },
    ]);
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
  });

  it.each([
    [null, 'missing membership'],
    [
      { roleId: '', status: 'active', tenantId: 'tenant-1', userId: 'user-1' },
      'role missing',
    ],
    [
      {
        roleId: 'role-1',
        status: 'pending',
        tenantId: 'tenant-1',
        userId: 'user-1',
      },
      'inactive',
    ],
    [
      {
        roleId: 'role-1',
        status: 'active',
        tenantId: 'tenant-2',
        userId: 'user-1',
      },
      'foreign tenant',
    ],
  ])('rejects %s', async (membership) => {
    mocks.findByUserAndTenant.mockResolvedValue(membership);
    const requestLocals = locals();

    await expect(verifyWorkspaceSubject(requestLocals)).resolves.toBeNull();
    expect(requestLocals.membership).toBeNull();
    expect(requestLocals.permissions).toEqual([]);
  });

  it('accepts a selected profile only when tenant and owner match the subject', async () => {
    const requestLocals = locals();
    await verifyWorkspaceSubject(requestLocals);
    mocks.get.mockResolvedValue({
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
      id: 'profile-1',
      ownerUserId: 'user-2',
      tenantId: 'tenant-1',
    });
    await expect(
      resolveWorkspaceSubjectForProfile('profile-1'),
    ).rejects.toBeInstanceOf(WorkspaceSubjectError);
  });

  it('keeps profile authority absent when the verified owner has no default profile', async () => {
    mocks.list.mockResolvedValue([]);
    const requestLocals = locals();

    await expect(verifyWorkspaceSubject(requestLocals)).resolves.toEqual({
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
