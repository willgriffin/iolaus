import { beforeEach, describe, expect, it, vi } from 'vitest';

const chat = {
  createAgentSession: vi.fn(),
  getThread: vi.fn(),
  getThreadMessages: vi.fn(),
  listRoomThreads: vi.fn(),
  startThread: vi.fn(),
  updateAgentSessionConfig: vi.fn(),
};
const create = vi.fn();

vi.mock('@happyvertical/smrt-chat', () => ({
  ChatService: { create },
}));

vi.mock('./smrt.js', () => ({
  getRequestScopedSmrtOptions: () => ({
    db: { type: 'sqlite', url: ':memory:' },
  }),
}));

const subject = {
  profileId: 'profile-1',
  tenantId: 'tenant-1',
  userId: 'user-1',
};

function session(overrides: Record<string, unknown> = {}) {
  return {
    id: 'session-1',
    tenantId: subject.tenantId,
    agentId: 'iolaus_admin_assistant',
    participantProfileId: subject.profileId,
    chatRoomId: 'room-1',
    isActive: () => true,
    getSessionKey: () =>
      `admin-assistant:${subject.tenantId}:${subject.userId}:${subject.profileId}`,
    ...overrides,
  };
}

function thread(overrides: Record<string, unknown> = {}) {
  return {
    id: 'thread-1',
    roomId: 'room-1',
    title: 'Chat',
    isResolved: false,
    messageCount: 1,
    lastMessageAt: new Date('2026-10-02T00:00:00.000Z'),
    ...overrides,
  };
}

function message(overrides: Record<string, unknown> = {}) {
  return {
    id: 'message-1',
    threadId: 'thread-1',
    content: 'Hello',
    role: 'user',
    created_at: new Date('2026-10-02T00:00:00.000Z'),
    getMetadata: () => ({ clientRequestId: 'request-1' }),
    ...overrides,
  };
}

describe('admin assistant native chat bridge', () => {
  beforeEach(() => {
    create.mockReset();
    for (const method of Object.values(chat)) {
      if ('mockReset' in method) method.mockReset();
    }
    create.mockResolvedValue(chat);
    chat.createAgentSession.mockResolvedValue({ room: {}, session: session() });
    chat.updateAgentSessionConfig.mockResolvedValue(session());
    chat.getThread.mockResolvedValue(thread());
  });

  it('creates a profile-scoped, tools-empty native session without runtime schema setup', async () => {
    const { getAdminAssistantChat } = await import('./admin-assistant-chat.js');

    await expect(getAdminAssistantChat(subject)).resolves.toMatchObject({
      session: expect.objectContaining({ id: 'session-1' }),
      subject,
    });

    expect(create).toHaveBeenCalledWith({
      db: { type: 'sqlite', url: ':memory:' },
      tenantId: subject.tenantId,
    });
    expect(chat.createAgentSession).toHaveBeenCalledWith({
      tenantId: subject.tenantId,
      agentId: 'iolaus_admin_assistant',
      actorProfileId: subject.profileId,
      allowedTools: [],
      sessionKey: 'admin-assistant:tenant-1:user-1:profile-1',
    });
    expect(chat.updateAgentSessionConfig).toHaveBeenCalledWith({
      agentSessionId: 'session-1',
      tenantId: subject.tenantId,
      actorProfileId: subject.profileId,
      allowedTools: [],
    });
  });

  it('refuses a foreign-thread id before attempting a membership-gated message read', async () => {
    const { getAdminAssistantChat, listAdminAssistantMessages } = await import(
      './admin-assistant-chat.js'
    );
    chat.getThread.mockResolvedValue(thread({ roomId: 'foreign-room' }));

    const assistant = await getAdminAssistantChat(subject);
    await expect(
      listAdminAssistantMessages(assistant, 'foreign-thread'),
    ).rejects.toThrow('was not found');
    expect(chat.getThreadMessages).not.toHaveBeenCalled();
  });

  it('serializes only chronological member-visible thread messages', async () => {
    const { getAdminAssistantChat, listAdminAssistantMessages } = await import(
      './admin-assistant-chat.js'
    );
    chat.getThreadMessages.mockResolvedValue([
      message(),
      message({
        id: 'message-2',
        role: 'assistant',
        getMetadata: () => ({}),
      }),
    ]);

    const assistant = await getAdminAssistantChat(subject);
    await expect(
      listAdminAssistantMessages(assistant, 'thread-1'),
    ).resolves.toEqual([
      {
        id: 'message-1',
        threadId: 'thread-1',
        content: 'Hello',
        role: 'user',
        createdAt: '2026-10-02T00:00:00.000Z',
        clientRequestId: 'request-1',
      },
      {
        id: 'message-2',
        threadId: 'thread-1',
        content: 'Hello',
        role: 'assistant',
        createdAt: '2026-10-02T00:00:00.000Z',
      },
    ]);
    expect(chat.getThreadMessages).toHaveBeenCalledWith({
      tenantId: subject.tenantId,
      threadId: 'thread-1',
      actorProfileId: subject.profileId,
      limit: 100,
    });
  });

  it('does not persist a user turn until the dedicated governed provider configuration is complete', async () => {
    const {
      AdminAssistantUnavailableError,
      getAdminAssistantChat,
      sendAdminAssistantMessage,
    } = await import('./admin-assistant-chat.js');
    const assistant = await getAdminAssistantChat(subject);

    await expect(
      sendAdminAssistantMessage(assistant, {
        threadId: 'thread-1',
        content: 'Hello',
        clientRequestId: 'retry-key',
      }),
    ).rejects.toBeInstanceOf(AdminAssistantUnavailableError);

    const adapter = {
      run: vi.fn().mockResolvedValue({ inProgress: true }),
    };
    await expect(
      sendAdminAssistantMessage(assistant, {
        adapter,
        threadId: 'thread-1',
        content: 'Hello',
        clientRequestId: 'retry-key',
      }),
    ).resolves.toEqual({ inProgress: true });
    expect(adapter.run).toHaveBeenCalledWith(
      expect.objectContaining({
        clientRequestId: 'retry-key',
        content: 'Hello',
        subject,
        thread: expect.objectContaining({ id: 'thread-1' }),
      }),
    );
  });
});
