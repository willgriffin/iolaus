import { error } from '@sveltejs/kit';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ load: vi.fn(), save: vi.fn() }));
vi.mock('$lib/server/career-management', () => ({
  loadCareerManagement: mocks.load,
  saveCareerSection: mocks.save,
}));

import { actions, load } from './+page.server';

beforeEach(() => vi.clearAllMocks());
const locals = {
  workspaceSubject: {
    tenantId: 'tenant',
    userId: 'owner',
    profileId: 'profile',
  },
} as App.Locals;
describe('Career route', () => {
  it('forwards only verified request locals to the canonical loader', async () => {
    const data = {
      source: { profile: { name: 'Fictional Candidate' } },
      sections: [],
    };
    mocks.load.mockResolvedValueOnce(data);
    expect(await load({ locals } as never)).toBe(data);
    expect(mocks.load).toHaveBeenCalledWith(locals);
  });
  it('returns an actual save result for visible feedback', async () => {
    const body = new FormData();
    body.set('section', 'profile');
    body.set('id', 'profile');
    body.set('summary', 'Revised');
    mocks.save.mockResolvedValueOnce({
      ok: true,
      message: 'Saved profile and summary.',
    });
    const result = await actions.save({
      locals,
      request: new Request('http://localhost/admin/career?/save', {
        method: 'POST',
        body,
      }),
    } as never);
    expect(result).toEqual({ ok: true, message: 'Saved profile and summary.' });
    expect(mocks.save.mock.calls[0][0]).toBe(locals);
    expect(mocks.save.mock.calls[0][1].get('summary')).toBe('Revised');
  });
  it.each([
    400, 403, 404,
  ])('returns safe action failure for HTTP %s', async (status) => {
    mocks.save.mockImplementationOnce(() =>
      error(status, 'Career record not found.'),
    );
    const result = await actions.save({
      locals,
      request: new Request('http://localhost/admin/career?/save', {
        method: 'POST',
        body: new FormData(),
      }),
    } as never);
    expect(result).toMatchObject({
      status,
      data: { ok: false, error: 'Career record not found.' },
    });
  });
});
