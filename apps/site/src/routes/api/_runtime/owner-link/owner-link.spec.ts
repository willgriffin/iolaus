import { beforeEach, describe, expect, it, vi } from 'vitest';

const signInOwner = vi.hoisted(() => vi.fn());
vi.mock('$lib/server/application-runtime', () => ({
  applicationRuntime: { profile: 'local' },
  getLocalApplicationRuntime: async () => ({ signInOwner }),
}));
vi.mock('$lib/server/auth', () => ({ sessionCookieName: 'iolaus-session' }));

import { GET } from './+server';

function event(query = '', headers = {}) {
  return {
    url: new URL(`http://127.0.0.1:12345/api/_runtime/owner-link${query}`),
    request: new Request(
      `http://127.0.0.1:12345/api/_runtime/owner-link${query}`,
      { headers },
    ),
    locals: {},
    cookies: { set: vi.fn() },
    getClientAddress: () => '127.0.0.1',
  } as unknown as Parameters<typeof GET>[0];
}
describe('desktop owner link', () => {
  beforeEach(() => {
    vi.stubEnv('SMRT_DESKTOP_OWNER_LINK_SECRET', 'test-desktop-launch-secret');
    signInOwner.mockReset();
  });
  it('denies missing or incorrect launch proof before accessing owner state', async () => {
    for (const query of ['', '?launch=incorrect'])
      expect((await GET(event(query))).status).toBe(403);
    expect(signInOwner).not.toHaveBeenCalled();
  });
  it('denies cross-origin requests with otherwise valid launch proof', async () => {
    expect(
      (
        await GET(
          event('?launch=test-desktop-launch-secret', {
            origin: 'http://evil.invalid',
          }),
        )
      ).status,
    ).toBe(403);
    expect(signInOwner).not.toHaveBeenCalled();
  });
  it('uses native owner sign-in and the app session cookie', async () => {
    signInOwner.mockResolvedValue({ sessionId: 'session-test' });
    const request = event('?launch=test-desktop-launch-secret');
    const response = await GET(request);
    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toBe('/');
    expect(request.cookies.set).toHaveBeenCalledWith(
      'iolaus-session',
      'session-test',
      expect.objectContaining({ httpOnly: true, sameSite: 'lax' }),
    );
    expect(response.headers.get('cache-control')).toContain('no-store');
  });
});
