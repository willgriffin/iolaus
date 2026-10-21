import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('$lib/server/app-config', () => ({
  getAppConfig: () => ({ appName: 'Test App' }),
  getAuthConfiguration: () => ({ kind: 'magic-link' }),
}));
vi.mock('$lib/server/auth', () => ({
  completeMagicLinkLogin: vi.fn(),
  loginNextCookieName: 'iolaus_login_next_test',
}));

afterEach(() => vi.resetModules());

describe('magic-link confirm page', () => {
  it('uses a referrer policy that keeps Origin on its own form POST', async () => {
    const { load } = await import('./+page.server');
    const setHeaders = vi.fn();
    await load({
      setHeaders,
      url: new URL('https://example.test/auth/magic-link?token=abc'),
    } as never);

    const headers = setHeaders.mock.calls[0][0] as Record<string, string>;
    // no-referrer makes Chromium send `Origin: null` on same-origin form
    // POSTs, which SvelteKit's CSRF check rejects.
    expect(headers['referrer-policy']).not.toBe('no-referrer');
    expect(headers['referrer-policy']).toBe('same-origin');
    expect(headers['cache-control']).toBe('no-store');
  });
});

describe('OAuth return after magic-link sign in', () => {
  it.each([
    [
      '/oauth/authorize?client_id=client&state=opaque',
      '/oauth/authorize?client_id=client&state=opaque',
    ],
    ['https://attacker.test/', '/admin'],
    ['//attacker.test/', '/admin'],
  ])('returns only to a safe local consent path: %s', async (next, destination) => {
    const auth = await import('$lib/server/auth');
    vi.mocked(auth.completeMagicLinkLogin).mockResolvedValueOnce('signed-in');
    const { actions } = await import('./+page.server');
    const cookies = { get: vi.fn(() => next), delete: vi.fn() };
    const request = new Request('https://example.test/auth/magic-link', {
      method: 'POST',
      body: new URLSearchParams({ token: 'one-use-fixture' }),
    });
    await expect(
      actions.default({ request, cookies } as never),
    ).rejects.toMatchObject({ status: 303, location: destination });
    expect(cookies.delete).toHaveBeenCalledWith('iolaus_login_next_test', {
      path: '/',
    });
  });
});
