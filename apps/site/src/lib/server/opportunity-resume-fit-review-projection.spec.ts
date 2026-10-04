import { beforeEach, describe, expect, it, vi } from 'vitest';
import { loadCurrentOpportunityResumeFitReviewProjections } from './opportunity-resume-fit-review-projection.js';

const mocks = vi.hoisted(() => ({ read: vi.fn(), list: vi.fn() }));
vi.mock('./opportunity-resume-fit-review.js', () => ({
  readCurrentOpportunityResumeFitReview: mocks.read,
  OPPORTUNITY_RESUME_FIT_REVIEW_VERSION:
    'opportunity-resume-fit-review/v1-advisory',
}));
vi.mock('./private-workspace.js', () => ({ listPrivateRecords: mocks.list }));
vi.mock('./smrt.js', () => ({
  getCollection: vi.fn(() => {
    throw new Error('Projection spec must not read actual storage.');
  }),
  getRequestScopedSmrtOptions: vi.fn(),
}));
const subject = { tenantId: 'tenant', userId: 'user', profileId: 'profile' };
const result = {
  contractVersion: 'opportunity-resume-fit-review/v1-advisory',
  inputFingerprint: 'private-input',
  requestId: 'private-receipt',
  coverage: {
    candidateSourceCount: 1,
    reviewedRequirementIds: ['r1'],
    unresolvedClauseIds: ['c2'],
    sourceComplete: false,
    fullFit: 'unknown',
  },
  requirements: [
    {
      id: 'r1',
      text: 'Build APIs',
      status: 'strength',
      seniority: 'uncertain',
      note: 'Ownership depth is unclear.',
      candidateCitations: [],
      postingCitations: [],
    },
  ],
};
beforeEach(() => {
  mocks.read.mockReset();
  mocks.list
    .mockReset()
    .mockImplementation(async (_className, _subject, options) =>
      options.where['opportunityId in'].map((opportunityId: string) => ({
        opportunityId,
      })),
    );
});
describe('current private resume fit review projection', () => {
  it('uses only the native current reader and exposes advisory fields without receipt or scoring material', async () => {
    mocks.read.mockResolvedValue(result);
    const record = {
      id: 'opportunity',
      assessmentJson: '{"fitScore":100}',
      sourceContentFingerprint: 'current',
      sourceContentVersion: 2,
    };
    const projection = (
      await loadCurrentOpportunityResumeFitReviewProjections({
        opportunities: [record],
        subject,
      })
    ).get('opportunity');
    expect(mocks.read).toHaveBeenCalledWith(record, subject);
    expect(mocks.list).toHaveBeenCalledWith('OpportunityAssessment', subject, {
      where: {
        'opportunityId in': ['opportunity'],
        contractVersion: 'opportunity-resume-fit-review/v1-advisory',
        status: 'advisory',
      },
    });
    expect(projection).toEqual({
      version: 'opportunity-resume-fit-review-projection/v1',
      mode: 'advisory',
      sourceStatus: 'current',
      coverage: result.coverage,
      requirements: result.requirements,
    });
    expect(projection).not.toHaveProperty('requestId');
    expect(projection).not.toHaveProperty('fitScore');
    expect(projection?.requirements).not.toBe(result.requirements);
  });
  it('omits absent, stale or foreign receipts rejected by the attested reader', async () => {
    mocks.read.mockResolvedValue(null);
    expect(
      (
        await loadCurrentOpportunityResumeFitReviewProjections({
          opportunities: [{ id: 'stale', resumeFitReviewProjection: result }],
          subject,
        })
      ).size,
    ).toBe(0);
  });
  it('requires a selected private profile before reading', async () => {
    await expect(
      loadCurrentOpportunityResumeFitReviewProjections({
        opportunities: [{ id: 'x' }],
        subject: { ...subject, profileId: undefined },
      }),
    ).rejects.toThrow();
    expect(mocks.read).not.toHaveBeenCalled();
    expect(mocks.list).not.toHaveBeenCalled();
  });
  it('uses one owner-scoped selector and avoids catalog reconstruction for a page with no saved reviews', async () => {
    mocks.list.mockResolvedValue([]);
    const opportunities = Array.from({ length: 100 }, (_, id) => ({
      id: String(id),
    }));
    expect(
      (
        await loadCurrentOpportunityResumeFitReviewProjections({
          opportunities,
          subject,
        })
      ).size,
    ).toBe(0);
    expect(mocks.list).toHaveBeenCalledTimes(1);
    expect(mocks.read).not.toHaveBeenCalled();
  });
  it('deduplicates rows and bounds fresh reader concurrency to four', async () => {
    let active = 0;
    let peak = 0;
    mocks.read.mockImplementation(async () => {
      peak = Math.max(peak, ++active);
      await Promise.resolve();
      active--;
      return result;
    });
    const opportunities = Array.from({ length: 9 }, (_, id) => ({
      id: String(id),
    }));
    const projections = await loadCurrentOpportunityResumeFitReviewProjections({
      opportunities: [...opportunities, opportunities[0], { id: '' }],
      subject,
    });
    expect(peak).toBe(4);
    expect(mocks.read).toHaveBeenCalledTimes(9);
    expect(projections.size).toBe(9);
  });
  it('propagates receipt infrastructure failures instead of presenting them as missing evidence', async () => {
    mocks.read.mockRejectedValue(new Error('Receipt unavailable'));
    await expect(
      loadCurrentOpportunityResumeFitReviewProjections({
        opportunities: [{ id: 'x' }],
        subject,
      }),
    ).rejects.toThrow('Receipt unavailable');
  });
});
