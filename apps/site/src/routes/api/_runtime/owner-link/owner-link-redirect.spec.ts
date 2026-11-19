import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ handler: vi.fn() }));
vi.mock('@happyvertical/smrt-app-runtime/sveltekit', () => ({
  createOwnerLinkHandler: () => state.handler,
}));
vi.mock('$lib/server/application-runtime', () => ({
  applicationRuntime: { profile: 'local' },
  getLocalApplicationRuntime: vi.fn(),
}));
vi.mock('$lib/server/auth', () => ({ sessionCookieName: 'test-session' }));

import { GET } from './+server';

const event = {} as Parameters<typeof GET>[0];
describe('native workspace destination adapter', () => {
  beforeEach(() => state.handler.mockReset());
  it('changes only the SDK root redirect while preserving response and cookies', async () => {
    const response = new Response('fixture body', {
      status: 302,
      headers: {
        location: '/',
        'cache-control': 'private, no-store',
        'x-fixture': 'retained',
      },
    });
    response.headers.append(
      'set-cookie',
      'owner=fixture; HttpOnly; SameSite=Lax',
    );
    response.headers.append('set-cookie', 'other=fixture; HttpOnly');
    const cookies = response.headers.getSetCookie();
    state.handler.mockResolvedValue(response);
    const result = await GET(event);
    expect(result).toBe(response);
    expect(result.status).toBe(302);
    expect(result.headers.get('location')).toBe('/admin/');
    expect(result.headers.getSetCookie()).toEqual(cookies);
    expect(result.headers.get('cache-control')).toBe('private, no-store');
    expect(result.headers.get('x-fixture')).toBe('retained');
    expect(await result.text()).toBe('fixture body');
  });
  for (const [status, location] of [
    [403, '/'],
    [200, '/'],
    [307, '/'],
    [302, '/setup'],
  ] as const) {
    it(`leaves ${status} ${location} unchanged`, async () => {
      const response = new Response('retained body', {
        status,
        headers: { location },
      });
      state.handler.mockResolvedValue(response);
      const result = await GET(event);
      expect(result).toBe(response);
      expect(result.status).toBe(status);
      expect(result.headers.get('location')).toBe(location);
      expect(await result.text()).toBe('retained body');
    });
  }
});
