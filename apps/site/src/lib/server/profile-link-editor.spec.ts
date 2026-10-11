import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  collection: vi.fn(),
  invalidate: vi.fn(),
  permission: vi.fn(),
  verify: vi.fn(),
  create: vi.fn(),
}));
vi.mock('./smrt.js', () => ({ getCollection: mocks.collection }));
vi.mock('./resume-data.js', () => ({
  invalidatePublishedResumeCache: mocks.invalidate,
}));
vi.mock('./owner-principal.js', () => ({
  isOwnerAuthorityDenial: (e: unknown) =>
    e instanceof Error && e.message === 'denied',
  runAsOwner: async (
    _: unknown,
    fn: (run: { assertOperation: typeof mocks.permission }) => Promise<unknown>,
  ) => fn({ assertOperation: mocks.permission }),
}));
vi.mock('./workspace-subject.js', () => ({
  workspaceSubjectFromLocals: (locals: { workspaceSubject?: unknown }) => {
    if (!locals.workspaceSubject) throw new Error('Verified session required');
    return locals.workspaceSubject;
  },
  requireCandidateWorkspaceSubject: (subject: unknown) => subject,
  withVerifiedWorkspaceSubject: async (
    subject: unknown,
    fn: (subject: unknown) => Promise<unknown>,
  ) => {
    await mocks.verify();
    return fn(subject);
  },
}));

import { loadProfileLinkEditor, saveProfileLink } from './profile-link-editor';

const subject = { tenantId: 'tenant', userId: 'owner', profileId: 'profile' };
const locals = { workspaceSubject: subject } as App.Locals;
const ownership = {
  tenantId: 'tenant',
  ownerUserId: 'owner',
  candidateProfileId: 'profile',
};
type Row = Record<string, unknown> & {
  id: string;
  save: ReturnType<typeof vi.fn>;
};
let profile: Row;
let links: Row[];
function form(values: Record<string, string> = {}) {
  const f = new FormData();
  for (const [key, value] of Object.entries({
    provider: 'github',
    href: 'https://github.com/example',
    ...values,
  }))
    f.set(key, value);
  return f;
}
beforeEach(() => {
  vi.resetAllMocks();
  profile = {
    id: 'profile',
    ...ownership,
    active: true,
    profileKey: 'candidate',
    save: vi.fn(),
  };
  links = [
    {
      id: 'link',
      ...ownership,
      label: 'My projects',
      href: 'https://github.com/old',
      useOnResume: false,
      sortOrder: 7,
      save: vi.fn(),
    },
  ];
  mocks.collection.mockImplementation(async (name: string) => ({
    get: async (id: string) =>
      name === 'CandidateProfile'
        ? profile
        : (links.find((row) => row.id === id) ?? null),
    list: async () => links,
    create: mocks.create,
  }));
  mocks.create.mockResolvedValue({ id: 'new-link' });
});
describe('profile links editor', () => {
  it('prefills known URLs, preserves duplicates/custom links, and never creates placeholders on load', async () => {
    links.push(
      { ...links[0], id: 'duplicate' },
      {
        ...links[0],
        id: 'custom',
        href: 'https://work.example',
        label: 'Work',
      },
    );
    const result = await loadProfileLinkEditor(locals);
    expect(result.providers.find((p) => p.id === 'github')?.link).toMatchObject(
      { id: 'link', label: 'My projects', useOnResume: false },
    );
    expect(result.providers.find((p) => p.id === 'linkedin')?.link).toBeNull();
    expect(result.customLinks.map((l) => l.id)).toEqual([
      'duplicate',
      'custom',
    ]);
    expect(mocks.create).not.toHaveBeenCalled();
  });
  it('saves only the selected existing URL, preserving label, order and visibility', async () => {
    await saveProfileLink(locals, form({ id: 'link' }));
    expect(links[0]).toMatchObject({
      label: 'My projects',
      useOnResume: false,
      sortOrder: 7,
      href: 'https://github.com/example',
    });
    expect(links[0].save).toHaveBeenCalledOnce();
    expect(mocks.invalidate).toHaveBeenCalledOnce();
  });
  it('creates a populated link with server-derived profile key and ownership', async () => {
    await saveProfileLink(
      locals,
      form({
        profileKey: 'forged',
        candidateProfileId: 'foreign',
        ownerUserId: 'foreign',
        tenantId: 'foreign',
      }),
    );
    expect(mocks.create).toHaveBeenCalledWith(
      expect.objectContaining({
        ...ownership,
        profileKey: 'candidate',
        label: 'GitHub',
        useOnResume: true,
      }),
    );
  });
  it('does not create records for an empty optional provider', async () => {
    await expect(
      saveProfileLink(locals, form({ href: '' })),
    ).resolves.toMatchObject({ ok: true });
    expect(mocks.create).not.toHaveBeenCalled();
  });
  it.each([
    'javascript:alert(1)',
    'not a URL',
    'https://github.com.evil.test/me',
    'https://name:password@github.com/me',
    'https://linkedin.com/in/me',
  ])('rejects unsafe or mismatched provider URL %s', async (href) => {
    await expect(saveProfileLink(locals, form({ href }))).rejects.toMatchObject(
      { status: 400 },
    );
    expect(mocks.create).not.toHaveBeenCalled();
  });
  it.each([
    { tenantId: 'foreign' },
    { ownerUserId: 'foreign' },
    { candidateProfileId: 'foreign' },
  ])('denies cross-context edits and reads %j', async (foreign) => {
    Object.assign(links[0], foreign);
    await expect(
      saveProfileLink(locals, form({ id: 'link' })),
    ).rejects.toMatchObject({ status: 404 });
    const result = await loadProfileLinkEditor(locals);
    expect(result.providers.every((p) => !p.link)).toBe(true);
    expect(links[0].save).not.toHaveBeenCalled();
  });
  it('rechecks permissions and profile activation at the write fence', async () => {
    mocks.verify
      .mockImplementationOnce(async () => {})
      .mockImplementationOnce(async () => {
        profile.active = false;
      });
    await expect(saveProfileLink(locals, form())).rejects.toMatchObject({
      status: 403,
    });
    expect(mocks.create).not.toHaveBeenCalled();
    expect(mocks.permission).toHaveBeenCalledTimes(2);
  });
  it('does not invalidate resume caches after a failed save', async () => {
    links[0].save.mockRejectedValue(new Error('database unavailable'));
    await expect(saveProfileLink(locals, form({ id: 'link' }))).rejects.toThrow(
      'database unavailable',
    );
    expect(mocks.invalidate).not.toHaveBeenCalled();
  });
  it('updates a custom label without changing other metadata', async () => {
    await saveProfileLink(
      locals,
      form({
        id: 'link',
        provider: 'custom',
        label: 'New label',
        href: 'https://portfolio.example/path',
      }),
    );
    expect(links[0]).toMatchObject({
      label: 'New label',
      useOnResume: false,
      sortOrder: 7,
    });
  });
});
