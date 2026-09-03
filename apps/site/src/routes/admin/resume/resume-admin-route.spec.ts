import { beforeEach, describe, expect, it, vi } from 'vitest';

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

import { actions, load } from './+page.server';

beforeEach(() => {
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
      load({ url: new URL('https://iolaus.localhost/admin/resume') } as never),
    ).resolves.toMatchObject({
      activeResumeTab: 'data',
      source: LEGACY_SOURCE,
    });
  });

  it('keeps editable normalized records when no default profile can be assembled', async () => {
    mocks.loadNormalizedResumeSource.mockResolvedValue(null);
    mocks.loadLegacyAdminResumeSource.mockResolvedValue(null);
    mocks.getCollection.mockImplementation(async (className: string) => ({
      list: vi.fn(async () => {
        if (className === 'CandidateProfile') return [{ id: 'profile-1' }];
        if (className === 'Experience') return [{ id: 'experience-1' }];
        if (className === 'Education') return [{ id: 'education-1' }];
        return [];
      }),
    }));

    await expect(
      load({ url: new URL('https://iolaus.localhost/admin/resume') } as never),
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
