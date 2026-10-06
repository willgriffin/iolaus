import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  enabled: vi.fn(),
  getAssistant: vi.fn(),
  listMessages: vi.fn(),
  requireSubject: vi.fn(),
  sendMessage: vi.fn(),
  verifiedSubject: vi.fn(),
  workspaceSubject: vi.fn(),
}));

class UnavailableError extends Error {}
class MissingThreadError extends Error {}

vi.mock('$lib/server/admin-assistant-config.js', () => ({
  isAdminAssistantEnabled: mocks.enabled,
}));
vi.mock('$lib/server/admin-assistant-chat.js', () => ({
  AdminAssistantThreadNotFoundError: MissingThreadError,
  AdminAssistantUnavailableError: UnavailableError,
  getAdminAssistantChat: mocks.getAssistant,
  listAdminAssistantMessages: mocks.listMessages,
  sendAdminAssistantMessage: mocks.sendMessage,
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
  return new Request(
    'http://localhost/api/admin/assistant/threads/thread-1/messages',
    {
      body: JSON.stringify(body),
      headers: { 'content-type': 'application/json' },
      method: 'POST',
    },
  );
}

const event = (request?: Request) =>
  ({ locals: {}, params: { threadId: 'thread-1' }, request }) as never;

describe('admin assistant messages route', () => {
  beforeEach(() => {
    for (const mock of Object.values(mocks)) mock.mockReset();
    mocks.enabled.mockReturnValue(true);
    mocks.workspaceSubject.mockReturnValue(subject);
    mocks.requireSubject.mockImplementation((candidate) => candidate);
    mocks.verifiedSubject.mockImplementation(
      async (candidate, callback) => await callback(candidate),
    );
    mocks.getAssistant.mockResolvedValue({ subject });
    mocks.listMessages.mockResolvedValue([]);
  });

  it('feature-gates before it reads identity, validates input, or opens chat storage', async () => {
    mocks.enabled.mockReturnValue(false);
    const { POST } = await handler();

    await expect(POST(event(post({})))).rejects.toMatchObject({ status: 404 });

    expect(mocks.workspaceSubject).not.toHaveBeenCalled();
    expect(mocks.getAssistant).not.toHaveBeenCalled();
    expect(mocks.sendMessage).not.toHaveBeenCalled();
  });

  it('lists messages only through the verified server subject and room-gated service', async () => {
    mocks.listMessages.mockResolvedValue([
      {
        content: 'Hello',
        createdAt: '2026-10-02T00:00:00.000Z',
        id: 'message-1',
        role: 'user',
        threadId: 'thread-1',
      },
    ]);
    const { GET } = await handler();

    const response = await GET(event());

    await expect(response.json()).resolves.toEqual({
      items: [
        {
          content: 'Hello',
          createdAt: '2026-10-02T00:00:00.000Z',
          id: 'message-1',
          role: 'user',
          threadId: 'thread-1',
        },
      ],
    });
    expect(mocks.listMessages).toHaveBeenCalledWith({ subject }, 'thread-1');
  });

  it('does not send malformed content', async () => {
    const { POST } = await handler();

    await expect(
      POST(event(post({ clientRequestId: 'request-1' }))),
    ).rejects.toMatchObject({
      status: 400,
    });

    expect(mocks.workspaceSubject).not.toHaveBeenCalled();
    expect(mocks.sendMessage).not.toHaveBeenCalled();
  });

  it('returns 503 before a provider call or user-message write while no governed adapter exists', async () => {
    mocks.sendMessage.mockRejectedValue(new UnavailableError('not configured'));
    const { POST } = await handler();

    const response = await POST(
      event(
        post({ content: 'Help with my inbox', clientRequestId: 'request-1' }),
      ),
    );

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({
      message: 'not configured',
    });
    expect(mocks.sendMessage).toHaveBeenCalledWith(
      { subject },
      {
        clientRequestId: 'request-1',
        content: 'Help with my inbox',
        threadId: 'thread-1',
      },
    );
  });

  it('returns a clear refusal with the right status when AI is off or the user budget is spent', async () => {
    const { AiUsageRefusedError } = await import(
      '$lib/server/ai-usage-guard.js'
    );
    const { POST } = await handler();
    for (const [code, status] of [
      ['user_budget_exhausted', 429],
      ['ai_disabled', 503],
    ] as const) {
      mocks.sendMessage.mockRejectedValue(
        new AiUsageRefusedError(code, `refused: ${code}`),
      );
      const response = await POST(
        event(post({ content: 'Hello', clientRequestId: `request-${code}` })),
      );
      expect(response.status).toBe(status);
      await expect(response.json()).resolves.toEqual({
        code,
        message: `refused: ${code}`,
      });
    }
  });

  it('hides a foreign thread as not found', async () => {
    mocks.listMessages.mockRejectedValue(new MissingThreadError());
    const { GET } = await handler();

    await expect(GET(event())).rejects.toMatchObject({ status: 404 });
  });
});
