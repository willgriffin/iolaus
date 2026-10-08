import { describe, expect, it, vi } from 'vitest';

const calls = vi.hoisted(() => ({
  get: vi.fn(async () => [{ id: 'job', score: 70 }]),
  run: vi.fn(async (_locals, fn) => fn({ assertOperation: async () => {} })),
}));
vi.mock('$lib/server/opportunity-matching.js', () => ({
  getMyOpportunityMatches: calls.get,
}));
vi.mock('$lib/server/owner-principal.js', () => ({
  runAsOwner: calls.run,
  isOwnerAuthorityDenial: () => false,
}));

import { GET } from './+server.js';

const owner = { tenantId: 'tenant', userId: 'user', profileId: 'profile' };
function event(locals: Record<string, unknown>, query = '') {
  return {
    locals,
    url: new URL(`https://example.test/api/public/v1/me/matches${query}`),
  } as unknown as Parameters<typeof GET>[0];
}
const locals = {
  user: { id: 'user' },
  tenantId: 'tenant',
  workspaceSubject: owner,
  membership: {
    tenantId: 'tenant',
    userId: 'user',
    roleId: 'role',
    status: 'active',
  },
};
describe('private me/matches route', () => {
  it('denies anonymous requests and always disables caching', async () => {
    const result = await GET(event({}));
    expect(result.status).toBe(401);
    expect(result.headers.get('cache-control')).toBe('private, no-store');
  });
  it('uses only the authenticated subject and rejects malformed bounds', async () => {
    const result = await GET(event(locals));
    expect(result.status).toBe(200);
    expect(calls.get).toHaveBeenCalledWith(owner, { limit: 25 });
    expect(result.headers.get('vary')).toBe('Authorization, Cookie');
    expect((await GET(event(locals, '?limit=Infinity'))).status).toBe(400);
    expect(
      (
        await GET(
          event({ ...locals, workspaceSubject: { ...owner, userId: 'other' } }),
        )
      ).status,
    ).toBe(403);
  });
});
