import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  load: vi.fn(),
  discover: vi.fn(),
  confirm: vi.fn(),
  dismiss: vi.fn(),
}));
vi.mock('$lib/server/candidate-skill-discovery', () => ({
  loadCandidateSkillDiscovery: mocks.load,
  discoverCandidateSkills: mocks.discover,
  confirmCandidateSkillProposal: mocks.confirm,
  dismissCandidateSkillProposal: mocks.dismiss,
  CandidateSkillDiscoveryError: class extends Error {
    constructor(
      readonly status: number,
      message: string,
    ) {
      super(message);
    }
  },
}));

import { CandidateSkillDiscoveryError } from '$lib/server/candidate-skill-discovery';

vi.mock('$lib/server/smrt.js', () => ({
  getCollection: vi.fn(),
  getRequestScopedSmrtOptions: vi.fn(),
}));
vi.mock('$lib/server/db.js', () => ({ getSmrtOptions: vi.fn() }));

import { actions, load } from './+page.server';

const subject = { tenantId: 'tenant', userId: 'owner', profileId: 'profile' };
const locals = {
  workspaceSubject: subject,
  tenantId: 'tenant',
  user: { id: 'owner' },
  membership: {
    userId: 'owner',
    tenantId: 'tenant',
    roleId: 'role',
    status: 'active',
  },
} as App.Locals;
const snapshot = { proposals: [], revision: 'snapshot' };
function event(overrides: Record<string, string> = {}, actor = locals) {
  const form = new FormData();
  for (const [key, value] of Object.entries({
    id: 'proposal',
    expectedRevision: 'opaque-revision',
    ...overrides,
  }))
    form.set(key, value);
  return {
    locals: actor,
    request: new Request('http://localhost/admin/resume/skill-discovery', {
      method: 'POST',
      body: form,
    }),
  };
}
beforeEach(() => {
  vi.clearAllMocks();
  for (const mock of Object.values(mocks)) mock.mockResolvedValue(snapshot);
});
describe('private skill discovery route', () => {
  it('reports partial discovery as resumable without claiming it finished', async () => {
    mocks.discover.mockResolvedValue({ ...snapshot, status: 'partial' });
    expect(await actions.discover(event() as never)).toMatchObject({
      ok: true,
      message: expect.stringContaining(
        'Continue to assess the remaining skills',
      ),
    });
  });

  it('loads proposals without starting discovery or adding skills', async () => {
    expect(await load({ locals } as never)).toEqual({ snapshot });
    expect(mocks.load).toHaveBeenCalledExactlyOnceWith(subject);
    expect(mocks.discover).not.toHaveBeenCalled();
    expect(mocks.confirm).not.toHaveBeenCalled();
  });
  it('discovers explicitly under verified subject and reports review next', async () => {
    expect(
      await actions.discover(event({ profileId: 'foreign' }) as never),
    ).toMatchObject({ ok: true, snapshot });
    expect(mocks.discover).toHaveBeenCalledExactlyOnceWith(subject);
    expect(mocks.confirm).not.toHaveBeenCalled();
  });
  it.each([
    'confirm',
    'dismiss',
  ] as const)('sends only native opaque locator for %s, never submitted ownership or skill evidence', async (action) => {
    expect(
      await actions[action](
        event({
          profileId: 'foreign',
          tenantId: 'foreign',
          canonicalLabel: 'Forged',
          evidence: 'forged',
          classification: 'direct',
        }) as never,
      ),
    ).toMatchObject({ ok: true, snapshot });
    expect(mocks[action]).toHaveBeenCalledExactlyOnceWith(subject, {
      id: 'proposal',
      expectedRevision: 'opaque-revision',
    });
  });
  it.each([
    'discover',
    'confirm',
    'dismiss',
  ] as const)('denies invalid workspace before %s service', async (action) => {
    for (const invalid of [
      { ...locals, membership: null },
      { ...locals, tenantId: 'foreign' },
      { ...locals, workspaceSubject: { ...subject, profileId: '' } },
      { ...locals, membership: { ...locals.membership, status: 'inactive' } },
    ]) {
      expect(
        await actions[action](event({}, invalid as App.Locals) as never),
      ).toMatchObject({ status: 403, data: { ok: false } });
    }
    expect(mocks[action]).not.toHaveBeenCalled();
  });
  it.each([
    'discover',
    'confirm',
    'dismiss',
  ] as const)('returns native failure feedback without claiming success for %s', async (action) => {
    mocks[action].mockRejectedValue(
      new CandidateSkillDiscoveryError(409, 'Evidence changed; rediscover.'),
    );
    expect(await actions[action](event() as never)).toMatchObject({
      status: 409,
      data: { ok: false, error: 'Evidence changed; rediscover.' },
    });
  });
  it('forwards missing locator as empty for native validation', async () => {
    await actions.confirm(event({ id: '', expectedRevision: '' }) as never);
    expect(mocks.confirm).toHaveBeenCalledWith(subject, {
      id: '',
      expectedRevision: '',
    });
  });
});
