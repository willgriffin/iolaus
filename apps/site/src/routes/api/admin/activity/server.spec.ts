import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  runAsOwner: vi.fn(),
  assertOperation: vi.fn(),
  load: vi.fn(),
  subject: vi.fn(),
  requireSubject: vi.fn(),
}));
vi.mock('$lib/server/owner-principal.js', () => ({
  runAsOwner: mocks.runAsOwner,
  isOwnerAuthorityDenial: (cause: unknown) =>
    cause instanceof Error && cause.message === 'authority denied',
}));
vi.mock('$lib/server/workspace-activity.js', () => ({
  loadWorkspaceActivity: mocks.load,
}));
vi.mock('$lib/server/workspace-subject.js', () => ({
  workspaceSubjectFromLocals: mocks.subject,
  requireCandidateWorkspaceSubject: mocks.requireSubject,
  WorkspaceSubjectError: class extends Error {
    status = 403;
  },
  CandidateProfileRequiredError: class extends Error {
    status = 409;
  },
}));
vi.mock('$lib/server/workspace-workflow-capabilities.js', () => ({
  workspaceWorkflowOperation: () => ({
    collection: 'workflow',
    action: 'application.inspect',
  }),
}));

import { GET } from './+server.js';

const subject = {
  tenantId: 'tenant-a',
  userId: 'user-a',
  profileId: 'profile-a',
};
const snapshot = {
  items: [],
  observedAt: '2026-10-02T21:00:00.000Z',
  truncated: false,
};
function request() {
  return {
    locals: { user: { id: 'user-a' }, workspaceSubject: subject },
    url: new URL(
      'http://localhost/api/admin/activity?profileId=foreign&tenantId=foreign',
    ),
  };
}

describe('authenticated workspace activity endpoint', () => {
  beforeEach(() => {
    for (const mock of Object.values(mocks)) mock.mockReset();
    mocks.subject.mockReturnValue(subject);
    mocks.requireSubject.mockImplementation((value) => value);
    mocks.runAsOwner.mockImplementation(
      async (_locals, work) =>
        await work({ assertOperation: mocks.assertOperation }),
    );
    mocks.load.mockResolvedValue(snapshot);
  });
  it('returns 401 without workspace/storage resolution when no user is authenticated', async () => {
    const response = await GET({ locals: {} } as never);
    expect(response.status).toBe(401);
    expect(mocks.runAsOwner).not.toHaveBeenCalled();
    expect(mocks.load).not.toHaveBeenCalled();
  });
  it('reads only the server selected subject after the current principal capability guard', async () => {
    const response = await GET(request() as never);
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual(snapshot);
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    expect(mocks.load).toHaveBeenCalledWith(subject);
    expect(mocks.assertOperation).toHaveBeenCalledWith(
      'workflow',
      'application.inspect',
    );
    expect(mocks.assertOperation.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.load.mock.invocationCallOrder[0]!,
    );
    expect(mocks.runAsOwner).toHaveBeenCalledWith(
      request().locals,
      expect.any(Function),
      { action: 'admin.activity.read' },
    );
  });
  it('fails closed on a revoked principal before loading activity', async () => {
    mocks.assertOperation.mockRejectedValue(new Error('authority denied'));
    const response = await GET(request() as never);
    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({ error: 'Forbidden' });
    expect(mocks.load).not.toHaveBeenCalled();
  });
  it('returns forbidden for a missing selected profile rather than falling back to a tenant read', async () => {
    const { WorkspaceSubjectError } = await import(
      '$lib/server/workspace-subject.js'
    );
    mocks.requireSubject.mockImplementation(() => {
      throw new WorkspaceSubjectError(403, 'missing profile');
    });
    const response = await GET(request() as never);
    expect(response.status).toBe(403);
    expect(mocks.load).not.toHaveBeenCalled();
  });
  it('answers 409 when the user has not created a candidate profile yet', async () => {
    const { CandidateProfileRequiredError } = await import(
      '$lib/server/workspace-subject.js'
    );
    mocks.requireSubject.mockImplementation(() => {
      throw new CandidateProfileRequiredError();
    });
    const response = await GET(request() as never);
    expect(response.status).toBe(409);
    expect(mocks.load).not.toHaveBeenCalled();
  });
  it('distinguishes native unavailable from an honest empty snapshot without leaking its error', async () => {
    mocks.load.mockRejectedValue(
      new Error('PRIVATE database credentials and input'),
    );
    const response = await GET(request() as never);
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({
      error: 'Activity unavailable',
    });
    expect(response.headers.get('cache-control')).toBe('private, no-store');
  });
});
