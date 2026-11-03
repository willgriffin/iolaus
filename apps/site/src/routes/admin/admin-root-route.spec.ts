import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  loadAdminOverview: vi.fn(),
  getCurrentSessionPermissionContext: vi.fn(),
  withSessionPermissionContext: vi.fn(),
  withVerifiedWorkspaceSubject: vi.fn(),
  workspaceSubjectFromLocals: vi.fn(),
}));
vi.mock('@happyvertical/smrt-users', () => ({
  getCurrentSessionPermissionContext: mocks.getCurrentSessionPermissionContext,
  withSessionPermissionContext: mocks.withSessionPermissionContext,
}));
vi.mock('$lib/server/db', () => ({
  getSmrtOptions: () => ({ db: { type: 'postgres' } }),
}));
vi.mock('$lib/server/admin-overview', () => ({
  loadAdminOverview: mocks.loadAdminOverview,
}));
vi.mock('$lib/server/workspace-subject', () => ({
  withVerifiedWorkspaceSubject: mocks.withVerifiedWorkspaceSubject,
  workspaceSubjectFromLocals: mocks.workspaceSubjectFromLocals,
}));

import { load } from './+page';
import { load as serverLoad } from './+page.server';

beforeEach(() => {
  vi.resetAllMocks();
});

describe('/admin overview route', () => {
  it('loads the verified request workspace without redirecting to tasks', async () => {
    const subject = {
      tenantId: 'tenant-a',
      userId: 'user-a',
      profileId: 'profile-a',
    };
    const overview = { tasks: [], opportunities: [], pendingOpportunities: [] };
    mocks.workspaceSubjectFromLocals.mockReturnValue(subject);
    const deferred = Promise.withResolvers<typeof overview>();
    mocks.loadAdminOverview.mockReturnValue(deferred.promise);
    const locals = { workspaceSubject: subject };
    const data = await serverLoad({ locals } as never);
    expect(mocks.workspaceSubjectFromLocals).toHaveBeenCalledWith(locals);
    expect(mocks.loadAdminOverview).toHaveBeenCalledWith(subject);
    expect(await load({ data } as never)).toEqual({
      overview: deferred.promise,
    });
    deferred.resolve(overview);
    await expect(data.overview).resolves.toEqual(overview);
  });

  it('streams using an independent RLS scope when the hook has a transaction', async () => {
    const subject = {
      tenantId: 'tenant',
      userId: 'user',
      profileId: 'profile',
    };
    const session = { session: {}, tenantId: 'tenant', userId: 'user' };
    const gate = Promise.withResolvers<typeof session>();
    const overview = { tasks: [], opportunities: [], pendingOpportunities: [] };
    mocks.workspaceSubjectFromLocals.mockReturnValue(subject);
    mocks.getCurrentSessionPermissionContext.mockReturnValue({
      postgresRls: true,
      sessionId: 'synthetic-session',
    });
    mocks.withSessionPermissionContext.mockImplementation(
      async (_options, work) => work(await gate.promise),
    );
    mocks.withVerifiedWorkspaceSubject.mockImplementation(
      async (verified, work) => work(verified),
    );
    mocks.loadAdminOverview.mockResolvedValue(overview);

    const data = await serverLoad({ locals: {} } as never);
    expect(mocks.withSessionPermissionContext).toHaveBeenCalledWith(
      {
        db: { type: 'postgres' },
        enterTenantContext: true,
        postgresRls: true,
        sessionId: 'synthetic-session',
      },
      expect.any(Function),
    );
    expect(mocks.loadAdminOverview).not.toHaveBeenCalled();
    gate.resolve(session);
    await expect(data.overview).resolves.toEqual(overview);
    expect(mocks.withVerifiedWorkspaceSubject).toHaveBeenCalledWith(
      subject,
      mocks.loadAdminOverview,
    );
  });

  it('denies a resumed RLS scope with a different tenant or missing session', async () => {
    mocks.workspaceSubjectFromLocals.mockReturnValue({
      tenantId: 'tenant',
      userId: 'user',
      profileId: 'profile',
    });
    mocks.getCurrentSessionPermissionContext.mockReturnValue({
      postgresRls: true,
      sessionId: 'synthetic-session',
    });
    for (const session of [
      { session: {}, tenantId: 'foreign', userId: 'user' },
      { session: {}, tenantId: 'tenant', userId: 'foreign' },
      { session: null, tenantId: 'tenant', userId: 'user' },
    ]) {
      mocks.withSessionPermissionContext.mockImplementation(
        async (_options, work) => work(session),
      );
      const data = await serverLoad({ locals: {} } as never);
      await expect(data.overview).rejects.toMatchObject({ status: 403 });
    }
    expect(mocks.withVerifiedWorkspaceSubject).not.toHaveBeenCalled();
    expect(mocks.loadAdminOverview).not.toHaveBeenCalled();
  });

  it('does not read private data when the hook subject is unavailable', async () => {
    mocks.workspaceSubjectFromLocals.mockImplementation(() => {
      throw new Error('unverified');
    });
    await expect(serverLoad({ locals: {} } as never)).rejects.toThrow(
      'unverified',
    );
    expect(mocks.loadAdminOverview).not.toHaveBeenCalled();
  });
});
