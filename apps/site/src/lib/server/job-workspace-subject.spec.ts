import { getCurrentTenant, withTenant } from '@happyvertical/smrt-tenancy';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  assertOperation: vi.fn(),
  execute: vi.fn(),
  app: { runtimeProfile: 'local', workspaceMode: 'private' },
  auth: { kind: 'local' } as Record<string, unknown>,
  membership: vi.fn(),
  profile: vi.fn(),
  tenant: vi.fn(),
  user: vi.fn(),
  verified: vi.fn(),
}));

vi.mock('@happyvertical/smrt-agents', () => ({
  executeAsPrincipal: mocks.execute,
}));
vi.mock('@happyvertical/smrt-users', () => ({
  MembershipCollection: {
    create: vi.fn(async () => ({ findByUserAndTenant: mocks.membership })),
  },
  MembershipStatus: { ACTIVE: 'active' },
  TenantCollection: { create: vi.fn(async () => ({ get: mocks.tenant })) },
  TenantStatus: { ACTIVE: 'active' },
  UserCollection: { create: vi.fn(async () => ({ get: mocks.user })) },
  UserStatus: { ACTIVE: 'active' },
}));
vi.mock('./app-config.js', () => ({
  getAppConfig: () => mocks.app,
  getAuthConfiguration: () => mocks.auth,
}));
vi.mock('./db.js', () => ({ getSmrtOptions: () => ({ db: 'test' }) }));
vi.mock('./smrt.js', () => ({
  getCollection: vi.fn(async () => ({ get: mocks.profile })),
}));
vi.mock('./workspace-subject.js', () => ({
  requireCurrentWorkspaceSubject: mocks.verified,
}));
vi.mock('./private-workspace.js', () => ({
  getPrivateRecord: vi.fn(),
  requireWorkspaceSubject: (value: unknown) => value,
}));
vi.mock('./workspace-workflow-capabilities.js', () => ({
  workspaceWorkflowOperation: (capability: string) => ({
    action: capability,
    collection: 'workflow',
  }),
}));

import {
  assertJobTenantMatchesRuntimeWorkspaceSubject,
  captureRuntimeWorkspaceSubject,
  JobWorkspaceSubjectError,
  requireJobResourceOwnedBySubject,
  revalidateRuntimeWorkspaceSubject,
  runAsResolvedJobWorkspaceSubject,
  runAsRevalidatedJobWorkspaceSubject,
  withRuntimeWorkspaceSubject,
} from './job-workspace-subject';

const subject = {
  profileId: 'profile-1',
  tenantId: 'tenant-1',
  userId: 'user-1',
};

describe('queued workspace subject', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.app.runtimeProfile = 'local';
    mocks.app.workspaceMode = 'private';
    mocks.auth = { kind: 'local' };
    mocks.verified.mockReturnValue(subject);
    mocks.user.mockImplementation(async (id) => ({
      email: `${id}@example.invalid`,
      id,
      status: 'active',
    }));
    mocks.tenant.mockImplementation(async (id) => ({ id, status: 'active' }));
    mocks.membership.mockImplementation(async (userId, tenantId) => ({
      roleId: 'role-1',
      status: 'active',
      tenantId,
      userId,
    }));
    mocks.profile.mockImplementation(async (id) => ({
      active: true,
      id,
      ownerUserId: id === 'profile-2' ? 'user-2' : 'user-1',
      tenantId: id === 'profile-2' ? 'tenant-2' : 'tenant-1',
    }));
    mocks.assertOperation.mockResolvedValue(undefined);
    mocks.execute.mockImplementation(
      async (
        options: { principal: { tenantId: string; runAsUserId: string } },
        fn: (run: unknown) => Promise<unknown>,
      ) =>
        await withTenant(
          {
            metadata: {},
            tenantId: options.principal.tenantId,
            userId: options.principal.runAsUserId,
          },
          async () => await fn({ assertOperation: mocks.assertOperation }),
        ),
    );
  });

  it('captures only the verified subject and rejects forged ownership fields', () => {
    expect(withRuntimeWorkspaceSubject({ reason: 'manual' })).toMatchObject({
      runtimeWorkspaceSubject: subject,
    });
    expect(() => withRuntimeWorkspaceSubject({ userId: 'forged' })).toThrow(
      JobWorkspaceSubjectError,
    );
    expect(captureRuntimeWorkspaceSubject()).toEqual(subject);
  });

  it.each([
    [{}, 'missing envelope'],
    [
      { runtimeWorkspaceSubject: { ...subject, profileId: 'foreign' } },
      'foreign profile',
    ],
  ])('rejects %s before work', async (args, _name) => {
    if ((args as Record<string, unknown>).runtimeWorkspaceSubject)
      mocks.profile.mockResolvedValue(null);
    const work = vi.fn();
    await expect(
      runAsResolvedJobWorkspaceSubject(args, work),
    ).rejects.toBeInstanceOf(JobWorkspaceSubjectError);
    expect(work).not.toHaveBeenCalled();
  });

  it.each([
    ['revoked user', 'user'],
    ['revoked membership', 'membership'],
    ['inactive tenant', 'tenant'],
  ])('rejects %s', async (_name, denied) => {
    if (denied === 'user')
      mocks.user.mockResolvedValue({ id: subject.userId, status: 'suspended' });
    if (denied === 'membership')
      mocks.membership.mockResolvedValue({
        roleId: 'role-1',
        status: 'revoked',
        tenantId: subject.tenantId,
        userId: subject.userId,
      });
    if (denied === 'tenant')
      mocks.tenant.mockResolvedValue({
        id: subject.tenantId,
        status: 'suspended',
      });
    await expect(
      runAsResolvedJobWorkspaceSubject(
        { runtimeWorkspaceSubject: subject },
        async () => 'no',
      ),
    ).rejects.toBeInstanceOf(JobWorkspaceSubjectError);
  });

  it('rejects an active profile whose durable owner tuple was reassigned', async () => {
    mocks.profile.mockResolvedValue({
      active: true,
      id: subject.profileId,
      ownerUserId: 'other-user',
      tenantId: subject.tenantId,
    });
    const work = vi.fn();

    await expect(
      runAsResolvedJobWorkspaceSubject(
        { runtimeWorkspaceSubject: subject },
        work,
      ),
    ).rejects.toThrow('candidate profile is not active');
    expect(work).not.toHaveBeenCalled();
  });

  it('rechecks the private hosted owner allowlist with the freshly loaded email', async () => {
    mocks.app.runtimeProfile = 'self-hosted';
    mocks.auth = {
      kind: 'self-hosted',
      oidc: { adminEmails: ['different@example.invalid'] },
    };
    mocks.user.mockResolvedValue({
      email: 'owner@example.invalid',
      id: subject.userId,
      status: 'active',
    });
    const work = vi.fn();

    await expect(
      runAsResolvedJobWorkspaceSubject(
        { runtimeWorkspaceSubject: subject },
        work,
      ),
    ).rejects.toThrow('no longer authorized');
    expect(work).not.toHaveBeenCalled();
  });

  it('does not impose the private owner allowlist on a shared member job', async () => {
    mocks.app.runtimeProfile = 'self-hosted';
    mocks.app.workspaceMode = 'shared';
    mocks.auth = {
      kind: 'self-hosted',
      oidc: { adminEmails: ['different@example.invalid'] },
    };

    await expect(
      runAsResolvedJobWorkspaceSubject(
        { runtimeWorkspaceSubject: subject },
        async () => 'completed',
      ),
    ).resolves.toBe('completed');
  });

  it('rechecks a revoked membership at the in-context write fence', async () => {
    mocks.membership.mockResolvedValue({
      roleId: 'role-1',
      status: 'revoked',
      tenantId: subject.tenantId,
      userId: subject.userId,
    });

    await expect(
      withTenant(
        { metadata: {}, tenantId: subject.tenantId, userId: subject.userId },
        async () => await revalidateRuntimeWorkspaceSubject(subject),
      ),
    ).rejects.toThrow('membership is not active');
  });

  it('re-enters a fresh native principal context for the final capability fence', async () => {
    const observed = await runAsRevalidatedJobWorkspaceSubject(
      subject,
      'assessment.execute',
      async (current) => ({
        current,
        context: getCurrentTenant(),
      }),
    );

    expect(mocks.assertOperation).toHaveBeenCalledWith(
      'workflow',
      'assessment.execute',
    );
    expect(observed.current).toEqual(subject);
    expect(observed.context).toMatchObject({
      metadata: { workspaceSubject: subject },
      tenantId: subject.tenantId,
      userId: subject.userId,
    });
  });

  it('does not enter the final persistence callback when its capability is denied', async () => {
    mocks.assertOperation.mockRejectedValueOnce(new Error('denied'));
    const persist = vi.fn(async () => undefined);

    await expect(
      runAsRevalidatedJobWorkspaceSubject(
        subject,
        'assessment.execute',
        persist,
      ),
    ).rejects.toThrow('denied');
    expect(persist).not.toHaveBeenCalled();
  });

  it.each([
    'user',
    'membership',
    'profile',
  ] as const)('does not enter the final persistence callback after %s revocation', async (revoked) => {
    if (revoked === 'user') {
      mocks.user.mockResolvedValue({
        email: 'user-1@example.invalid',
        id: subject.userId,
        status: 'suspended',
      });
    }
    if (revoked === 'membership') {
      mocks.membership.mockResolvedValue({
        roleId: 'role-1',
        status: 'revoked',
        tenantId: subject.tenantId,
        userId: subject.userId,
      });
    }
    if (revoked === 'profile') {
      mocks.profile.mockResolvedValue({
        active: false,
        id: subject.profileId,
        ownerUserId: subject.userId,
        tenantId: subject.tenantId,
      });
    }
    const persist = vi.fn(async () => undefined);

    await expect(
      runAsRevalidatedJobWorkspaceSubject(
        subject,
        'assessment.execute',
        persist,
      ),
    ).rejects.toBeInstanceOf(JobWorkspaceSubjectError);
    expect(persist).not.toHaveBeenCalled();
  });

  it('restores isolated native context for concurrent profiles', async () => {
    const second = {
      profileId: 'profile-2',
      tenantId: 'tenant-2',
      userId: 'user-2',
    };
    const seen = await Promise.all(
      [subject, second].map(async (entry) => {
        return await runAsResolvedJobWorkspaceSubject(
          { runtimeWorkspaceSubject: entry },
          async (resolved) => {
            await Promise.resolve();
            return {
              metadataProfile: getCurrentTenant()?.metadata?.workspaceSubject,
              profileId: resolved.profileId,
              tenantId: getCurrentTenant()?.tenantId,
              userId: getCurrentTenant()?.userId,
            };
          },
        );
      }),
    );
    expect(seen).toEqual([
      {
        metadataProfile: subject,
        profileId: 'profile-1',
        tenantId: 'tenant-1',
        userId: 'user-1',
      },
      {
        metadataProfile: second,
        profileId: 'profile-2',
        tenantId: 'tenant-2',
        userId: 'user-2',
      },
    ]);
  });

  it('rejects a durable queue tenant mismatch independently of the envelope', () => {
    expect(() =>
      assertJobTenantMatchesRuntimeWorkspaceSubject(
        { tenantId: 'tenant-2' },
        subject,
      ),
    ).toThrow(JobWorkspaceSubjectError);
  });

  it('rejects a Task or AgentRun whose persisted owner tuple differs', () => {
    expect(() =>
      requireJobResourceOwnedBySubject(
        {
          candidateProfileId: 'profile-2',
          ownerUserId: subject.userId,
          tenantId: subject.tenantId,
        },
        subject,
        'Task',
      ),
    ).toThrow('outside the queued workspace subject');
  });
});
