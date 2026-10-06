import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  createThread: vi.fn(),
  enabled: vi.fn(),
  getAssistant: vi.fn(),
  listThreads: vi.fn(),
  requireSubject: vi.fn(),
  verifiedSubject: vi.fn(),
  workspaceSubject: vi.fn(),
}));

vi.mock('$lib/server/admin-assistant-config.js', () => ({
  isAdminAssistantEnabled: mocks.enabled,
}));
vi.mock('$lib/server/admin-assistant-chat.js', () => ({
  createAdminAssistantThread: mocks.createThread,
  getAdminAssistantChat: mocks.getAssistant,
  listAdminAssistantThreads: mocks.listThreads,
}));
vi.mock('$lib/server/workspace-subject.js', () => ({
  WorkspaceSubjectError: class WorkspaceSubjectError extends Error {
    status: number;
    constructor(status: number, message: string) {
      super(message);
      this.status = status;
    }
  },
  requireCandidateWorkspaceSubject: mocks.requireSubject,
  withVerifiedWorkspaceSubject: mocks.verifiedSubject,
  workspaceSubjectFromLocals: mocks.workspaceSubject,
}));

const subject = {
  profileId: 'profile-1',
  tenantId: 'tenant-1',
  userId: 'user-1',
};

async function handler() {
  return await import('./+server.js');
}

function post(body: unknown): Request {
  return new Request('http://localhost/api/admin/assistant/threads', {
    body: JSON.stringify(body),
    headers: { 'content-type': 'application/json' },
    method: 'POST',
  });
}

describe('admin assistant threads route', () => {
  beforeEach(() => {
    for (const mock of Object.values(mocks)) mock.mockReset();
    mocks.enabled.mockReturnValue(true);
    mocks.workspaceSubject.mockReturnValue(subject);
    mocks.requireSubject.mockImplementation((candidate) => candidate);
    mocks.verifiedSubject.mockImplementation(
      async (candidate, callback) => await callback(candidate),
    );
    mocks.getAssistant.mockResolvedValue({ subject });
    mocks.listThreads.mockResolvedValue([]);
    mocks.createThread.mockResolvedValue({
      id: 'thread-1',
      isResolved: false,
      lastMessageAt: null,
      messageCount: 0,
      title: 'Planning',
    });
  });

  it('feature-gates before resolving a workspace subject or opening chat storage', async () => {
    mocks.enabled.mockReturnValue(false);
    const { GET } = await handler();

    await expect(GET({ locals: {} } as never)).rejects.toMatchObject({
      status: 404,
    });

    expect(mocks.workspaceSubject).not.toHaveBeenCalled();
    expect(mocks.getAssistant).not.toHaveBeenCalled();
  });

  it('uses the freshly verified server subject to list member-owned threads', async () => {
    mocks.listThreads.mockResolvedValue([
      {
        id: 'thread-1',
        isResolved: false,
        lastMessageAt: null,
        messageCount: 0,
        title: 'Planning',
      },
    ]);
    const { GET } = await handler();

    const response = await GET({ locals: { arbitrary: 'ignored' } } as never);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      items: [
        {
          id: 'thread-1',
          isResolved: false,
          lastMessageAt: null,
          messageCount: 0,
          title: 'Planning',
        },
      ],
    });
    expect(mocks.workspaceSubject).toHaveBeenCalledWith({
      arbitrary: 'ignored',
    });
    expect(mocks.verifiedSubject).toHaveBeenCalledWith(
      subject,
      expect.any(Function),
    );
    expect(mocks.getAssistant).toHaveBeenCalledWith(subject);
    expect(mocks.listThreads).toHaveBeenCalledWith({ subject });
  });

  it('rejects malformed titles before creating a thread', async () => {
    const { POST } = await handler();

    await expect(
      POST({ locals: {}, request: post({ title: '   ' }) } as never),
    ).rejects.toMatchObject({ status: 400 });

    expect(mocks.workspaceSubject).not.toHaveBeenCalled();
    expect(mocks.createThread).not.toHaveBeenCalled();
  });

  it('creates only a bounded title through the verified server session', async () => {
    const { POST } = await handler();

    const response = await POST({
      locals: {},
      request: post({ title: '  Planning  ' }),
    } as never);

    expect(response.status).toBe(201);
    expect(mocks.createThread).toHaveBeenCalledWith({ subject }, 'Planning');
  });
});
