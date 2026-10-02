import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  loadAdminOverview: vi.fn(),
  workspaceSubjectFromLocals: vi.fn(),
}));
vi.mock('$lib/server/admin-overview', () => ({
  loadAdminOverview: mocks.loadAdminOverview,
}));
vi.mock('$lib/server/workspace-subject', () => ({
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
    mocks.loadAdminOverview.mockResolvedValue(overview);
    const locals = { workspaceSubject: subject };
    const data = await serverLoad({ locals } as never);
    expect(mocks.workspaceSubjectFromLocals).toHaveBeenCalledWith(locals);
    expect(mocks.loadAdminOverview).toHaveBeenCalledWith(subject);
    expect(await load({ data } as never)).toEqual({ overview });
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
