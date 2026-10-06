import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  aiChat: vi.fn(),
  complete: vi.fn(),
  fail: vi.fn(),
  getAssistant: vi.fn(),
  listMessages: vi.fn(),
  markRunning: vi.fn(),
  reserve: vi.fn(),
  resolveClient: vi.fn(),
  resolveConfig: vi.fn(),
  resolveDatabase: vi.fn(),
  sendAgentReply: vi.fn(),
  sendMessage: vi.fn(),
  serializeMessage: vi.fn(),
  verifySubject: vi.fn(),
}));

vi.mock('@happyvertical/smrt-core', () => ({
  resolveDatabase: mocks.resolveDatabase,
}));
vi.mock('@happyvertical/smrt-chat/internal/agent-runtime', () => ({
  sendAgentReply: mocks.sendAgentReply,
}));
vi.mock('./admin-assistant-turn-config.js', () => ({
  actualAssistantSpendMicros: vi.fn(() => ({
    basis: 'actual',
    spendMicros: 20,
  })),
  estimatedAssistantSpendMicros: vi.fn(() => 30),
  resolveAdminAssistantAiClient: mocks.resolveClient,
  resolveAdminAssistantTurnConfig: mocks.resolveConfig,
}));
vi.mock('./admin-assistant-turn-store.js', () => ({
  createAdminAssistantTurnStore: vi.fn(() => ({
    complete: mocks.complete,
    fail: mocks.fail,
    markRunning: mocks.markRunning,
    reserve: mocks.reserve,
  })),
}));
vi.mock('./smrt.js', () => ({
  getRequestScopedSmrtOptions: () => ({
    db: { type: 'sqlite', url: ':memory:' },
  }),
}));
vi.mock('./workspace-subject.js', () => ({
  requireCandidateWorkspaceSubject: (subject: unknown) => subject,
  withVerifiedWorkspaceSubject: mocks.verifySubject,
}));
vi.mock('./admin-assistant-chat.js', () => ({
  AdminAssistantThreadNotFoundError: class AdminAssistantThreadNotFoundError extends Error {},
  AdminAssistantUnavailableError: class AdminAssistantUnavailableError extends Error {},
  getAdminAssistantChat: mocks.getAssistant,
  listAdminAssistantMessages: mocks.listMessages,
  requireAdminAssistantThread: vi.fn(),
  serializeAdminAssistantMessage: mocks.serializeMessage,
}));

const subject = {
  profileId: 'profile-1',
  tenantId: 'tenant-1',
  userId: 'user-1',
};
const session = { chatRoomId: 'room-1', id: 'session-1' };
const thread = { id: 'thread-1' };

function input() {
  return {
    chat: { sendMessage: mocks.sendMessage },
    clientRequestId: 'client-request-1',
    content: 'Show the available application steps.',
    session,
    subject,
    thread,
  } as never;
}

describe('configured admin assistant turn adapter', () => {
  beforeEach(() => {
    for (const mock of Object.values(mocks)) mock.mockReset();
    mocks.resolveConfig.mockReturnValue({
      inputMicrosPerMillion: 100,
      maxInputTokens: 4096,
      maxOutputTokens: 128,
      model: 'openai/test',
      outputMicrosPerMillion: 100,
      sessionSpendLimitMicros: 1000,
      turnSpendLimitMicros: 200,
    });
    mocks.resolveClient.mockResolvedValue({
      aiClient: { chat: mocks.aiChat },
      model: 'openai/test',
      profile: 'admin-assistant',
      provider: 'bifrost',
      timeout: 5000,
    });
    mocks.resolveDatabase.mockResolvedValue({
      transaction: vi.fn(),
      url: ':memory:',
    });
    mocks.listMessages.mockResolvedValue([]);
    mocks.reserve.mockResolvedValue({
      kind: 'owner',
      turn: {
        id: 'turn-1',
        requestId: 'provider-request-1',
        reservedSpendMicros: 30,
      },
    });
    mocks.sendMessage.mockResolvedValue({ id: 'user-message-1' });
    mocks.markRunning.mockResolvedValue(undefined);
    mocks.aiChat.mockResolvedValue({
      content: 'You can begin from the Applications page.',
      usage: { completionTokens: 4, promptTokens: 10, totalTokens: 14 },
    });
    mocks.verifySubject.mockImplementation(
      async (candidate, callback) => await callback(candidate),
    );
    mocks.getAssistant.mockResolvedValue({ chat: {}, session, subject });
    mocks.sendAgentReply.mockResolvedValue({ id: 'assistant-message-1' });
    mocks.complete.mockResolvedValue(undefined);
    mocks.fail.mockResolvedValue(undefined);
    mocks.serializeMessage.mockImplementation((message: { id: string }) => ({
      content: message.id,
      createdAt: '2026-10-02T00:00:00.000Z',
      id: message.id,
      role: message.id.startsWith('assistant') ? 'assistant' : 'user',
      threadId: 'thread-1',
    }));
  });

  it('does nothing when the explicit assistant model and accounting configuration is absent', async () => {
    mocks.resolveConfig.mockReturnValue(null);
    const { runConfiguredAdminAssistantTurn } = await import(
      './admin-assistant-turn-adapter.js'
    );

    await expect(runConfiguredAdminAssistantTurn(input())).rejects.toBeTruthy();
    expect(mocks.listMessages).not.toHaveBeenCalled();
    expect(mocks.reserve).not.toHaveBeenCalled();
    expect(mocks.sendMessage).not.toHaveBeenCalled();
    expect(mocks.aiChat).not.toHaveBeenCalled();
  });

  it('reserves before transcript/provider work, refreshes authority before agent authoring, and settles once', async () => {
    const { runConfiguredAdminAssistantTurn } = await import(
      './admin-assistant-turn-adapter.js'
    );

    await expect(
      runConfiguredAdminAssistantTurn(input()),
    ).resolves.toMatchObject({
      assistantMessage: { id: 'assistant-message-1' },
      inProgress: false,
      userMessage: { id: 'user-message-1' },
    });
    expect(mocks.reserve.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.sendMessage.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY,
    );
    expect(mocks.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        actorProfileId: 'profile-1',
        agentSessionId: 'session-1',
        roomId: 'room-1',
        tenantId: 'tenant-1',
        threadId: 'thread-1',
      }),
    );
    expect(mocks.aiChat).toHaveBeenCalledWith(
      expect.any(Array),
      expect.objectContaining({ model: 'openai/test', toolChoice: 'none' }),
    );
    expect(mocks.verifySubject).toHaveBeenCalledWith(
      subject,
      expect.any(Function),
    );
    expect(mocks.sendAgentReply).toHaveBeenCalledWith(
      {},
      expect.objectContaining({
        agentSessionId: 'session-1',
        threadId: 'thread-1',
      }),
    );
    expect(mocks.complete).toHaveBeenCalledWith(
      expect.objectContaining({
        profileId: 'profile-1',
        tenantId: 'tenant-1',
        userId: 'user-1',
      }),
      'turn-1',
      expect.objectContaining({ assistantMessageId: 'assistant-message-1' }),
    );
  });

  it('replays a completed request without writing another message or calling the provider', async () => {
    mocks.reserve.mockResolvedValue({
      kind: 'completed',
      turn: {
        assistantMessageId: 'assistant-message-1',
        userMessageId: 'user-message-1',
      },
    });
    mocks.listMessages.mockResolvedValueOnce([]).mockResolvedValueOnce([
      { id: 'user-message-1', role: 'user' },
      { id: 'assistant-message-1', role: 'assistant' },
    ]);
    const { runConfiguredAdminAssistantTurn } = await import(
      './admin-assistant-turn-adapter.js'
    );

    await expect(
      runConfiguredAdminAssistantTurn(input()),
    ).resolves.toMatchObject({
      assistantMessage: { id: 'assistant-message-1' },
      inProgress: false,
      userMessage: { id: 'user-message-1' },
    });
    expect(mocks.sendMessage).not.toHaveBeenCalled();
    expect(mocks.aiChat).not.toHaveBeenCalled();
    expect(mocks.sendAgentReply).not.toHaveBeenCalled();
  });

  it('records a zero-cost failure when the native user-message write fails before provider dispatch', async () => {
    mocks.sendMessage.mockRejectedValue(new Error('room unavailable'));
    const { runConfiguredAdminAssistantTurn } = await import(
      './admin-assistant-turn-adapter.js'
    );

    await expect(runConfiguredAdminAssistantTurn(input())).rejects.toThrow(
      'room unavailable',
    );
    expect(mocks.aiChat).not.toHaveBeenCalled();
    expect(mocks.fail).toHaveBeenCalledWith(
      expect.any(Object),
      'turn-1',
      'provider_error',
      expect.objectContaining({
        accountingBasis: 'actual',
        actualSpendMicros: 0,
      }),
    );
  });
});
