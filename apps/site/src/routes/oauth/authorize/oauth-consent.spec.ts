import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  parse: vi.fn(),
  approve: vi.fn(),
  list: vi.fn(),
  revoke: vi.fn(),
}));
vi.mock('$lib/server/local-oauth', () => ({
  getLocalOAuth: async () => ({
    server: { parseAuthorizationRequest: mocks.parse },
    authorization: {
      approve: mocks.approve,
      listGrants: mocks.list,
      revokeGrant: mocks.revoke,
    },
  }),
  oauthScopePermissions: {
    'opportunities:read': ['workflow.application.inspect'],
    'applications:prepare': ['workflow.application.prepare'],
  },
  oauthScopeDescriptions: {
    'opportunities:read': 'Read opportunities',
    'applications:prepare': 'Prepare drafts',
  },
}));

import { actions as accountActions } from '../../account/connections/+page.server';
import { actions, load } from './+page.server';

function event(
  input: {
    origin?: string;
    csrf?: string;
    scopes?: string[];
    signedIn?: boolean;
  } = {},
) {
  const form = new URLSearchParams({
    csrf: input.csrf ?? 'nonce',
    decision: 'approve',
    grantId: 'foreign',
  });
  for (const scope of input.scopes ?? ['opportunities:read'])
    form.append('scope', scope);
  return {
    url: new URL('https://jobs.test/oauth/authorize?client_id=client'),
    request: new Request('https://jobs.test/oauth/authorize', {
      method: 'POST',
      headers: { origin: input.origin ?? 'https://jobs.test' },
      body: form,
    }),
    locals:
      input.signedIn === false
        ? {}
        : {
            user: { id: 'owner' },
            sessionId: 'session',
            permissions: ['workflow.application.inspect'],
          },
    cookies: { get: () => 'nonce', set: vi.fn(), delete: vi.fn() },
    setHeaders: vi.fn(),
  };
}
beforeEach(() => {
  vi.clearAllMocks();
  mocks.parse.mockResolvedValue({
    clientId: 'client',
    redirectUri: 'https://client.test/callback',
    scopes: ['opportunities:read', 'applications:prepare'],
  });
  mocks.approve.mockResolvedValue({
    redirectUri: 'https://client.test/callback?code=one-use',
  });
  mocks.list.mockResolvedValue([]);
});
describe('OAuth browser consent boundary', () => {
  it('preserves the authorize request through login', async () => {
    await expect(
      load(event({ signedIn: false }) as never),
    ).rejects.toMatchObject({
      status: 303,
      location: '/login?next=%2Foauth%2Fauthorize%3Fclient_id%3Dclient',
    });
  });
  it('displays requested scopes and current permission availability without issuing a code', async () => {
    const result = await load(event() as never);
    expect(result).toMatchObject({
      clientId: 'client',
      scopes: [{ permitted: true }, { permitted: false }],
    });
    expect(mocks.approve).not.toHaveBeenCalled();
  });
  it.each([
    { origin: 'https://attacker.test' },
    { csrf: 'wrong' },
    { signedIn: false },
  ])('rejects foreign, expired, or unauthenticated consent %j', async (input) => {
    await expect(actions.default(event(input) as never)).rejects.toMatchObject({
      status: input.signedIn === false ? 401 : 403,
    });
    expect(mocks.approve).not.toHaveBeenCalled();
  });
  it('intersects submitted scopes with both requested scopes and current permissions', async () => {
    await expect(
      actions.default(
        event({
          scopes: [
            'opportunities:read',
            'applications:prepare',
            'applications:submit',
          ],
        }) as never,
      ),
    ).rejects.toMatchObject({ status: 303 });
    expect(mocks.approve.mock.calls[0][1].scopes).toEqual([
      'opportunities:read',
    ]);
    expect(mocks.approve.mock.calls[0][2]).toBe('session');
  });
  it('rejects a foreign grant without reporting success', async () => {
    mocks.revoke.mockResolvedValue(false);
    expect(await accountActions.revoke(event() as never)).toMatchObject({
      status: 404,
    });
    expect(mocks.revoke).toHaveBeenCalledWith('session', 'foreign');
  });
  it('rejects cross-origin revocation', async () => {
    await expect(
      accountActions.revoke(
        event({ origin: 'https://attacker.test' }) as never,
      ),
    ).rejects.toMatchObject({ status: 403 });
    expect(mocks.revoke).not.toHaveBeenCalled();
  });
});
