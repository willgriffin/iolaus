import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ list: vi.fn(), mutate: vi.fn() }));
vi.mock('$lib/server/shortlist-service.js', () => ({
  listShortlist: mocks.list,
  mutateShortlist: mocks.mutate,
}));
vi.mock('$lib/server/owner-principal.js', () => ({
  OwnerPrincipalError: class extends Error {},
  isOwnerAuthorityDenial: () => false,
}));
vi.mock('$lib/server/shortlist-store.js', () => ({
  ShortlistStoreError: class extends Error {},
}));
vi.mock('$lib/server/workspace-subject.js', () => ({
  WorkspaceSubjectError: class extends Error {},
}));

import { GET, POST } from './+server.js';

const url = 'http://127.0.0.1/api/shortlist';
const payload = JSON.stringify({
  mutationId: '11111111-1111-4111-8111-111111111111',
  opportunityId: 'opportunity-1',
  expectedRevision: 0,
  decision: 'saved',
});
function event(request: Request) {
  return { locals: {}, request, url: new URL(url) } as never;
}
describe('shortlist account API fence', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.list.mockResolvedValue([]);
    mocks.mutate.mockResolvedValue({ id: 'entry' });
  });
  it('returns no-store data only through the account service', async () => {
    const response = await GET(event(new Request(url)));
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    expect(mocks.list).toHaveBeenCalledOnce();
  });
  it.each([
    new Request(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: payload,
    }),
    new Request(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        origin: 'http://foreign.invalid',
      },
      body: payload,
    }),
  ])('rejects a POST without its exact request origin before mutation', async (request) => {
    expect((await POST(event(request))).status).toBe(403);
    expect(mocks.mutate).not.toHaveBeenCalled();
  });
  it('accepts a bounded same-origin JSON mutation', async () => {
    const response = await POST(
      event(
        new Request(url, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            origin: 'http://127.0.0.1',
          },
          body: payload,
        }),
      ),
    );
    expect(response.status).toBe(200);
    expect(mocks.mutate).toHaveBeenCalledWith(
      {},
      expect.objectContaining({ opportunityId: 'opportunity-1' }),
    );
  });
});
