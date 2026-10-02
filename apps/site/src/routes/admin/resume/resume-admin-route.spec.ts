import { beforeEach, describe, expect, it, vi } from 'vitest';

const SUBJECT = {
  profileId: 'profile-1',
  tenantId: 'tenant-1',
  userId: 'user-1',
};
const OWNERSHIP = {
  candidateProfileId: SUBJECT.profileId,
  ownerUserId: SUBJECT.userId,
  tenantId: SUBJECT.tenantId,
};
const LOCALS = { workspaceSubject: SUBJECT };

const LEGACY_SOURCE = {
  experience: { education: [], other: [], positions: [] },
  profile: {
    email: 'will@example.com',
    links: [],
    name: 'Example Candidate',
    summary: 'Builds systems.',
    title: 'Programmer',
  },
  skills: { groups: [], skillGroups: [] },
};

const mocks = vi.hoisted(() => ({
  getCollection: vi.fn(),
  generateResumeAsset: vi.fn(),
  invalidatePublishedResumeCache: vi.fn(),
  listResumeAssets: vi.fn(),
  listResumeTailoringConfigs: vi.fn(),
  loadLegacyAdminResumeSource: vi.fn(),
  loadLegacyResumeSource: vi.fn(),
  loadNormalizedResumeSource: vi.fn(),
  loadResumeAssetPreviews: vi.fn(),
  publishResumeAsset: vi.fn(),
  regenerateResumeAsset: vi.fn(),
  assertOperation: vi.fn(),
  sharedHosted: false,
}));

vi.mock('$lib/server/resume-admin', () => ({
  generateResumeAsset: mocks.generateResumeAsset,
  loadResumeAssetPreviews: mocks.loadResumeAssetPreviews,
  publishResumeAsset: mocks.publishResumeAsset,
  regenerateResumeAsset: mocks.regenerateResumeAsset,
}));

vi.mock('$lib/server/resume-data', () => ({
  invalidatePublishedResumeCache: mocks.invalidatePublishedResumeCache,
  listResumeAssets: mocks.listResumeAssets,
  listResumeTailoringConfigs: mocks.listResumeTailoringConfigs,
  loadLegacyAdminResumeSource: mocks.loadLegacyAdminResumeSource,
  loadLegacyResumeSource: mocks.loadLegacyResumeSource,
  loadNormalizedResumeSource: mocks.loadNormalizedResumeSource,
}));

vi.mock('$lib/server/resume-source-refresh', () => ({
  withPublishedCanonicalRefresh: vi.fn(),
}));

vi.mock('$lib/server/smrt', () => ({
  getCollection: mocks.getCollection,
}));

vi.mock('$lib/server/app-config', () => ({
  isSharedHosted: () => mocks.sharedHosted,
}));
vi.mock('$lib/server/owner-principal', () => ({
  isOwnerAuthorityDenial: () => false,
  runAsOwner: async (
    _locals: unknown,
    fn: (run: unknown) => Promise<unknown>,
  ) => await fn({ assertOperation: mocks.assertOperation }),
}));
vi.mock('$lib/server/workspace-subject', () => ({
  workspaceSubjectFromLocals: (locals: { workspaceSubject?: unknown }) => {
    if (!locals?.workspaceSubject)
      throw new Error('Workspace session is not verified.');
    return locals.workspaceSubject;
  },
  requireCandidateWorkspaceSubject: (subject: unknown) => subject,
  withVerifiedWorkspaceSubject: async (
    subject: unknown,
    fn: (subject: unknown) => Promise<unknown>,
  ) => await fn(subject),
}));

import { actions, load } from './+page.server';

beforeEach(() => {
  mocks.sharedHosted = false;
  mocks.assertOperation.mockReset();
  mocks.getCollection.mockReset();
  mocks.generateResumeAsset.mockReset();
  mocks.invalidatePublishedResumeCache.mockReset();
  mocks.listResumeAssets.mockReset();
  mocks.listResumeTailoringConfigs.mockReset();
  mocks.loadLegacyAdminResumeSource.mockReset();
  mocks.loadLegacyResumeSource.mockReset();
  mocks.loadNormalizedResumeSource.mockReset();
  mocks.loadResumeAssetPreviews.mockReset();
  mocks.publishResumeAsset.mockReset();
  mocks.regenerateResumeAsset.mockReset();
  mocks.listResumeAssets.mockResolvedValue([]);
  mocks.listResumeTailoringConfigs.mockResolvedValue([]);
  mocks.loadResumeAssetPreviews.mockResolvedValue([]);
  mocks.loadLegacyResumeSource.mockReturnValue(LEGACY_SOURCE);
});

describe('admin resume load', () => {
  it('falls back to the bundled source when resume database reads fail', async () => {
    mocks.loadNormalizedResumeSource.mockRejectedValue(
      new Error('database unavailable'),
    );
    mocks.loadLegacyAdminResumeSource.mockRejectedValue(
      new Error('database unavailable'),
    );

    await expect(
      load({
        locals: LOCALS,
        url: new URL('https://iolaus.localhost/admin/resume'),
      } as never),
    ).resolves.toMatchObject({
      activeResumeTab: 'data',
      source: LEGACY_SOURCE,
    });
  });

  it('keeps editable normalized records when no default profile can be assembled', async () => {
    mocks.loadNormalizedResumeSource.mockResolvedValue(null);
    mocks.loadLegacyAdminResumeSource.mockResolvedValue(null);
    mocks.getCollection.mockImplementation(async (className: string) => ({
      get: vi.fn(async () => ({ id: 'profile-1', ...OWNERSHIP })),
      list: vi.fn(async () => {
        if (className === 'CandidateProfile')
          return [{ id: 'profile-1', ...OWNERSHIP }];
        if (className === 'Experience')
          return [{ id: 'experience-1', ...OWNERSHIP }];
        if (className === 'Education')
          return [{ id: 'education-1', ...OWNERSHIP }];
        return [];
      }),
    }));

    await expect(
      load({
        locals: LOCALS,
        url: new URL('https://iolaus.localhost/admin/resume'),
      } as never),
    ).resolves.toMatchObject({
      educationRecords: [{ id: 'education-1' }],
      experiences: [{ id: 'experience-1' }],
      profiles: [{ id: 'profile-1' }],
      source: LEGACY_SOURCE,
    });
  });
});

describe('resume regeneration', () => {
  it('does not claim an early failure was saved to history', async () => {
    mocks.regenerateResumeAsset.mockRejectedValue(
      new Error('resume source unavailable'),
    );
    const form = new FormData();
    form.set('assetId', 'resume-1');

    await expect(
      actions.regenerate({
        locals: LOCALS,
        request: new Request(
          'https://iolaus.localhost/admin/resume?/regenerate',
          {
            body: form,
            method: 'POST',
          },
        ),
      } as never),
    ).resolves.toMatchObject({
      data: {
        error:
          'Resume regeneration failed. Check the resume history and retry.',
      },
      status: 500,
    });
  });
});

describe('private resume route scope', () => {
  it('passes the verified selected profile to each private source and artifact list', async () => {
    mocks.loadNormalizedResumeSource.mockResolvedValueOnce(LEGACY_SOURCE);
    mocks.getCollection.mockImplementation(async () => ({
      get: vi.fn(async () => null),
      list: vi.fn(async () => []),
    }));
    await load({
      locals: LOCALS,
      url: new URL('https://iolaus.localhost/admin/resume'),
    } as never);
    expect(mocks.loadNormalizedResumeSource).toHaveBeenCalledWith(
      undefined,
      SUBJECT,
    );
    expect(mocks.listResumeTailoringConfigs).toHaveBeenCalledWith(SUBJECT);
    expect(mocks.listResumeAssets).toHaveBeenCalledWith(SUBJECT);
  });

  it('requires a verified session before attempting resume reads', async () => {
    await expect(
      load({
        locals: {},
        url: new URL('https://iolaus.localhost/admin/resume'),
      } as never),
    ).rejects.toThrow('Workspace session is not verified');
    expect(mocks.loadNormalizedResumeSource).not.toHaveBeenCalled();
    expect(mocks.listResumeAssets).not.toHaveBeenCalled();
  });

  it('rejects a same-tenant foreign education update without saving it', async () => {
    const foreign = {
      id: 'foreign-education',
      ...OWNERSHIP,
      ownerUserId: 'foreign-user',
      save: vi.fn(),
    };
    mocks.getCollection.mockResolvedValueOnce({
      get: vi.fn(async () => foreign),
    });
    const form = new FormData();
    form.set('id', foreign.id);
    form.set('title', 'Forged');
    const result = await actions.updateEducation({
      locals: LOCALS,
      request: new Request(
        'https://iolaus.localhost/admin/resume?/updateEducation',
        { method: 'POST', body: form },
      ),
    } as never);
    expect(result).toMatchObject({ ok: false, error: 'Record not found' });
    expect(mocks.assertOperation).toHaveBeenCalledWith(
      'workflow',
      'profile.manage',
    );
    expect(foreign.save).not.toHaveBeenCalled();
  });

  it('generates with the verified subject after checking the native workflow capability', async () => {
    const form = new FormData();
    form.set('tailoringId', 'owned-tailoring');
    await actions.generate({
      locals: LOCALS,
      request: new Request('https://iolaus.localhost/admin/resume?/generate', {
        method: 'POST',
        body: form,
      }),
    } as never);
    expect(mocks.assertOperation).toHaveBeenCalledWith(
      'workflow',
      'profile.manage',
    );
    expect(mocks.generateResumeAsset).toHaveBeenCalledWith({
      subject: SUBJECT,
      tailoringId: 'owned-tailoring',
    });
  });
});
