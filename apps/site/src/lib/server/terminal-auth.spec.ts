import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  sessionService: { kind: 'session-service' },
  sessionServiceCreate: vi.fn(),
  withSessionPermissionContext: vi.fn(),
}));

vi.mock('@happyvertical/smrt-users', () => ({
  SessionService: { create: mocks.sessionServiceCreate },
  withSessionPermissionContext: mocks.withSessionPermissionContext,
}));

vi.mock('./smrt.js', () => ({ getCollection: vi.fn() }));

describe('terminal bearer-session context', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.sessionServiceCreate.mockResolvedValue(mocks.sessionService);
    mocks.withSessionPermissionContext.mockImplementation(
      async (
        _options: Record<string, unknown>,
        fn: (context: Record<string, unknown>) => unknown,
      ) => await fn({ session: { id: 'session-1' } }),
    );
  });

  it('runs bearer work through the SMRT session and tenant context', async () => {
    const { withBearerSessionContext } = await import('./terminal-auth');
    const callback = vi.fn(async () => 'ok');

    const result = await withBearerSessionContext('terminal-token', callback);

    expect(result).toBe('ok');
    expect(mocks.withSessionPermissionContext).toHaveBeenCalledWith(
      expect.objectContaining({
        enterTenantContext: true,
        sessionId: 'terminal-token',
        sessionService: mocks.sessionService,
      }),
      callback,
    );
  });
});
