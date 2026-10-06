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
  sharedHosted: false,
  invited: true,
  isEmailInvited: vi.fn(async () => mocks.invited),
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
    runtimeProfile:
      mocks.privateHosted || mocks.sharedHosted ? 'cloud' : 'local',
    workspaceMode: mocks.privateHosted ? 'private' : 'shared',
  }),
}));
vi.mock('./hosted-invite.js', () => ({
  isEmailInvited: mocks.isEmailInvited,
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
  CandidateProfileRequiredError,
  candidateProfileOnboardingRedirect,
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
    mocks.sharedHosted = false;
    mocks.invited = true;
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

  describe('shared hosted invite gate', () => {
    beforeEach(() => {
      mocks.sharedHosted = true;
      mocks.invited = true;
    });

    it('admits an invited shared-hosted user', async () => {
      await expect(verifyWorkspaceSubject(locals())).resolves.toMatchObject({
        userId: 'user-1',
      });
      expect(mocks.isEmailInvited).toHaveBeenCalled();
    });

    it('rejects an uninvited shared-hosted user and flags the invite page', async () => {
      mocks.invited = false;
      const requestLocals = locals() as ReturnType<typeof locals> & {
        invitationRequired?: boolean;
      };
      await expect(
        revalidateWorkspaceIdentity({ tenantId: 'tenant-1', userId: 'user-1' }),
      ).rejects.toMatchObject({ status: 403 });
      await expect(verifyWorkspaceSubject(requestLocals)).resolves.toBeNull();
      expect(requestLocals.invitationRequired).toBe(true);
      expect(requestLocals.permissions).toEqual([]);
    });

    it('ends an existing session on the next request once the invite is revoked', async () => {
      await expect(verifyWorkspaceSubject(locals())).resolves.not.toBeNull();
      mocks.invited = false;
      await expect(verifyWorkspaceSubject(locals())).resolves.toBeNull();
    });

    it('does not consult invites for private hosted installations', async () => {
      mocks.sharedHosted = false;
      mocks.privateHosted = true;
      mocks.invited = false;
      await expect(verifyWorkspaceSubject(locals())).resolves.toMatchObject({
        userId: 'user-1',
      });
      expect(mocks.isEmailInvited).not.toHaveBeenCalled();
    });
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

  describe('hosted user without a candidate profile', () => {
    const noProfile = { workspaceSubject: { tenantId: 't', userId: 'u' } };

    it('raises a 409 profile-required error instead of a server fault', () => {
      expect(() =>
        requireCandidateWorkspaceSubject({ tenantId: 't', userId: 'u' }),
      ).toThrow(CandidateProfileRequiredError);
      expect(() =>
        requireCandidateWorkspaceSubject({ tenantId: 't', userId: 'u' }),
      ).toThrow(expect.objectContaining({ status: 409 }));
      expect(() =>
        requireCandidateWorkspaceSubject({ tenantId: '', userId: 'u' }),
      ).toThrow(expect.objectContaining({ status: 403 }));
    });

    it('redirects shared hosted admin pages to onboarding', () => {
      mocks.sharedHosted = true;
      expect(candidateProfileOnboardingRedirect(noProfile, '/admin')).toBe(
        '/admin/onboarding',
      );
      expect(
        candidateProfileOnboardingRedirect(noProfile, '/admin/resume'),
      ).toBe('/admin/onboarding');
    });

    it('lets the onboarding and account pages load without a profile', () => {
      mocks.sharedHosted = true;
      for (const path of [
        '/admin/onboarding',
        '/admin/account',
        '/admin/terminal-login',
      ]) {
        expect(candidateProfileOnboardingRedirect(noProfile, path)).toBeNull();
      }
    });

    it('does not redirect a user who already has a profile', () => {
      mocks.sharedHosted = true;
      expect(
        candidateProfileOnboardingRedirect(
          { workspaceSubject: { profileId: 'p', tenantId: 't', userId: 'u' } },
          '/admin',
        ),
      ).toBeNull();
    });

    it('leaves private hosted and local modes unchanged', () => {
      mocks.privateHosted = true;
      expect(
        candidateProfileOnboardingRedirect(noProfile, '/admin'),
      ).toBeNull();
      mocks.privateHosted = false;
      mocks.sharedHosted = false;
      expect(
        candidateProfileOnboardingRedirect(noProfile, '/admin'),
      ).toBeNull();
    });

    it("never selects another user's profile for a profile-less user", async () => {
      mocks.sharedHosted = true;
      // Storage returns only user A's profile; the owner-scoped query for user B
      // is what is asked, and a row owned by A must not become B's selection.
      mocks.list.mockResolvedValue([
        {
          active: true,
          id: 'profile-of-a',
          ownerUserId: 'user-a',
          profileKey: 'default',
          tenantId: 'tenant-1',
        },
      ]);
      mocks.getUser.mockResolvedValue({ id: 'user-b', isActive: () => true });
      mocks.findByUserAndTenant.mockResolvedValue({
        roleId: 'role-1',
        status: 'active',
        tenantId: 'tenant-1',
        userId: 'user-b',
      });
      const requestLocals = { ...locals(), user: { id: 'user-b' } };
      requestLocals.membership.userId = 'user-b';
      await expect(verifyWorkspaceSubject(requestLocals)).resolves.toEqual({
        tenantId: 'tenant-1',
        userId: 'user-b',
      });
      expect(mocks.list).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ ownerUserId: 'user-b' }),
        }),
      );
    });
  });
});
