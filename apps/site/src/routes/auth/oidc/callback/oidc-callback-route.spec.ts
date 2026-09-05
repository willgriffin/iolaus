import { isRedirect } from '@sveltejs/kit';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  completeOidcLogin: vi.fn(),
}));

vi.mock('$lib/server/auth', () => ({
  completeOidcLogin: mocks.completeOidcLogin,
  loginNextCookieName: 'iolaus_login_next_test',
}));

function event(next: string | undefined) {
  return {
    cookies: {
      delete: vi.fn(),
      get: vi.fn(() => next),
    },
  };
}

async function redirectFor(next: string | undefined) {
  const requestEvent = event(next);
  const { GET } = await import('./+server');
  try {
    await GET(requestEvent as never);
  } catch (cause) {
    if (isRedirect(cause)) {
      return { requestEvent, location: cause.location, status: cause.status };
    }
    throw cause;
  }
  throw new Error('Expected an OIDC callback redirect.');
}

describe('synthetic OIDC callback smoke', () => {
  beforeEach(() => {
    mocks.completeOidcLogin.mockReset();
    mocks.completeOidcLogin.mockResolvedValue(undefined);
  });

  it('completes the fake-provider callback before redirecting to the private UI', async () => {
    const { location, requestEvent, status } = await redirectFor(undefined);

    expect(mocks.completeOidcLogin).toHaveBeenCalledWith(requestEvent);
    expect(requestEvent.cookies.delete).toHaveBeenCalledWith(
      'iolaus_login_next_test',
      { path: '/' },
    );
    expect(status).toBe(303);
    expect(location).toBe('/admin');
  });

  it('keeps a server-issued next target after the fake-provider callback', async () => {
    const { location } = await redirectFor('/admin/opportunities?triage=1');

    expect(location).toBe('/admin/opportunities?triage=1');
  });
});
