import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createCliAuthRequest,
  destroyBearerSession,
  exchangeCliAuthDeviceCode,
} from '$lib/server/terminal-auth';
import { DELETE as sessionDelete, GET as sessionGet } from './session/+server';
import { POST as startPost } from './start/+server';
import { POST as tokenPost } from './token/+server';

vi.mock('$lib/server/terminal-auth', () => ({
  createCliAuthRequest: vi.fn(),
  destroyBearerSession: vi.fn(),
  exchangeCliAuthDeviceCode: vi.fn(),
}));

const createCliAuthRequestMock = vi.mocked(createCliAuthRequest);
const destroyBearerSessionMock = vi.mocked(destroyBearerSession);
const exchangeCliAuthDeviceCodeMock = vi.mocked(exchangeCliAuthDeviceCode);

describe('CLI auth API routes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('starts a terminal auth request for the current origin', async () => {
    createCliAuthRequestMock.mockResolvedValueOnce({
      deviceCode: 'device-1',
      expiresAt: '2026-05-25T12:00:00.000Z',
      interval: 2,
      userCode: 'IOLAUS-1234ABCD',
      verificationUrl:
        'https://iolaus.localhost/admin/terminal-login?code=IOLAUS-1234ABCD',
    });

    const response = await startPost({
      url: new URL('https://iolaus.localhost/api/cli/auth/start'),
    } as never);

    await expect(response.json()).resolves.toMatchObject({
      deviceCode: 'device-1',
      userCode: 'IOLAUS-1234ABCD',
    });
    expect(response.status).toBe(201);
    expect(createCliAuthRequestMock).toHaveBeenCalledWith(
      'https://iolaus.localhost',
    );
  });

  it('returns pending and expired token exchange payloads', async () => {
    exchangeCliAuthDeviceCodeMock
      .mockResolvedValueOnce({
        expiresAt: '2026-05-25T12:00:00.000Z',
        interval: 2,
        status: 'pending',
      })
      .mockResolvedValueOnce({ status: 'expired' });

    const pending = await tokenPost({
      request: new Request('https://iolaus.localhost/api/cli/auth/token', {
        body: JSON.stringify({ deviceCode: 'device-1' }),
        method: 'POST',
      }),
    } as never);
    const expired = await tokenPost({
      request: new Request('https://iolaus.localhost/api/cli/auth/token', {
        body: JSON.stringify({ deviceCode: 'device-2' }),
        method: 'POST',
      }),
    } as never);

    await expect(pending.json()).resolves.toMatchObject({ status: 'pending' });
    await expect(expired.json()).resolves.toEqual({ status: 'expired' });
    expect(exchangeCliAuthDeviceCodeMock).toHaveBeenNthCalledWith(
      1,
      'device-1',
    );
    expect(exchangeCliAuthDeviceCodeMock).toHaveBeenNthCalledWith(
      2,
      'device-2',
    );
  });

  it('rejects token exchange requests without a device code', async () => {
    const response = await tokenPost({
      request: new Request('https://iolaus.localhost/api/cli/auth/token', {
        body: JSON.stringify({}),
        method: 'POST',
      }),
    } as never);

    await expect(response.json()).resolves.toEqual({
      error: 'deviceCode is required.',
    });
    expect(response.status).toBe(400);
    expect(exchangeCliAuthDeviceCodeMock).not.toHaveBeenCalled();
  });

  it('returns authenticated bearer session details', async () => {
    const response = await sessionGet({
      locals: {
        sessionId: 'session-1',
        tenantId: 'tenant-1',
        user: { email: 'will@example.com', id: 'user-1' },
      },
    } as never);

    await expect(response.json()).resolves.toEqual({
      authenticated: true,
      sessionId: 'session-1',
      tenantId: 'tenant-1',
      user: { email: 'will@example.com', id: 'user-1' },
    });
  });

  it('requires an authenticated session for session status', async () => {
    const response = await sessionGet({ locals: {} } as never);

    await expect(response.json()).resolves.toEqual({ authenticated: false });
    expect(response.status).toBe(401);
  });

  it('destroys the bearer session during logout', async () => {
    destroyBearerSessionMock.mockResolvedValueOnce(true);

    const response = await sessionDelete({
      request: new Request('https://iolaus.localhost/api/cli/auth/session', {
        headers: { authorization: 'Bearer session-1' },
        method: 'DELETE',
      }),
    } as never);

    await expect(response.json()).resolves.toEqual({ authenticated: false });
    expect(destroyBearerSessionMock).toHaveBeenCalledWith('session-1');
  });
});
