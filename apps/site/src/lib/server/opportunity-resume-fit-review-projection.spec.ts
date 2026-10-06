import { beforeEach, describe, expect, it, vi } from 'vitest';
import { completeReviewFixture } from '../opportunity-resume-fit-review-projection.test-support';
import { loadCurrentOpportunityResumeFitReviewProjections } from './opportunity-resume-fit-review-projection.js';

const mocks = vi.hoisted(() => ({
  read: vi.fn(),
  readVerified: vi.fn(),
  list: vi.fn(),
}));
vi.mock('./opportunity-resume-fit-review.js', () => ({
  readCurrentOpportunityResumeFitReview: mocks.read,
  OPPORTUNITY_RESUME_FIT_REVIEW_VERSION:
    'opportunity-resume-fit-review/v2-catalog-aliases',
  OPPORTUNITY_RESUME_FIT_REVIEW_QUOTE_VERSION:
    'opportunity-resume-fit-review/v3-exact-quotes',
  OPPORTUNITY_RESUME_FIT_REVIEW_COMPLETE_VERSION:
    'opportunity-resume-fit-review/v4-complete-material',
}));
vi.mock('./opportunity-review-strength-verification.js', () => ({
  readCurrentOpportunityReviewStrengthVerification: mocks.readVerified,
  OPPORTUNITY_REVIEW_STRENGTH_VERIFICATION_V1_VERSION:
    'opportunity-review-strength-verification/v1-independent-jev',
  OPPORTUNITY_REVIEW_STRENGTH_VERIFICATION_VERSION:
    'opportunity-review-strength-verification/v2-partial-relevance',
  OPPORTUNITY_REVIEW_STRENGTH_VERIFICATION_MODEL: 'jev-1.13.0',
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
  contractVersion: 'opportunity-resume-fit-review/v2-catalog-aliases',
  mode: 'advisory',
  inputFingerprint: 'private-input',
  requestId: 'private-receipt',
  model: 'openai/gpt-6.1-sol',
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
  mocks.readVerified.mockReset();
  mocks.list
    .mockReset()
    .mockImplementation(async (_className, _subject, options) =>
      options.where['opportunityId in'].map((opportunityId: string) => ({
        opportunityId,
      })),
    );
});
describe('current private resume fit review projection', () => {
  it('projects continuous current V2 relevance and original Sol reasoning without promoting a subthreshold judgment', async () => {
    const source = completeReviewFixture({ uncertain: true });
    const original = completeReviewFixture();
    const effectiveReview = {
      ...source,
      coverage: { ...source.coverage, completion: source.completion },
      requirements: [
        {
          ...source.requirements[0],
          candidateCitations: original.requirements[0]?.candidateCitations,
        },
      ],
      contractVersion: 'opportunity-resume-fit-review/v4-complete-material',
      model: 'openai/gpt-6.1-sol',
    };
    const originalReview = {
      ...original,
      contractVersion: effectiveReview.contractVersion,
      model: effectiveReview.model,
    };
    const version =
      'opportunity-review-strength-verification/v2-partial-relevance';
    const verification = {
      version,
      model: 'jev-1.13.0',
      strengthClaimCount: 1,
      verifiedStrengthCount: 0,
      seniorityClaimCount: 1,
      verifiedSeniorityCount: 0,
      partialClaimCount: 1,
      verifiedPartialCount: 0,
      partialSupportedRequirementIds: [],
    };
    mocks.list.mockResolvedValue([
      {
        opportunityId: 'complete',
        contractVersion: version,
        status: 'strength_verified',
      },
    ]);
    mocks.readVerified.mockResolvedValue({
      contractVersion: version,
      mode: 'independent_strength_verification',
      model: 'jev-1.13.0',
      originalReview,
      effectiveReview,
      verification,
      judgments: [
        {
          requirementId: 'material:c1',
          dimension: 'partial_relevance',
          probability: 0.42,
          verified: false,
        },
      ],
    });
    const projections = await loadCurrentOpportunityResumeFitReviewProjections({
      opportunities: [{ id: 'complete' }],
      subject,
    });
    expect(projections.get('complete')).toMatchObject({
      evidenceFit: { supportedCriterionCount: 0, status: 'needs_evidence' },
      advisoryRelevance: {
        kind: 'supplied_evidence_relevance',
        denominator: 1,
        weightedMean: 0.42,
        criterionProbabilityPairs: [
          {
            requirementId: 'material:c1',
            probability: 0.42,
            evidenceStatus: 'cited',
          },
        ],
      },
      verification: { verifiedStrengthCount: 0, verifiedPartialCount: 0 },
    });
    expect(projections.get('complete')?.requirements[0]).toMatchObject({
      status: 'uncertain',
      originalSolSuggestion: {
        status: 'strength',
        note: original.requirements[0]?.note,
      },
    });
    expect(originalReview.requirements[0]?.status).toBe('strength');
  });

  it('prefers owned current V2 partial evidence over V1 without using saved JSON claims', async () => {
    const fixture = completeReviewFixture({ uncertain: true });
    const effectiveReview = {
      ...fixture,
      requirements: [
        {
          ...fixture.requirements[0],
          candidateCitations:
            completeReviewFixture().requirements[0]?.candidateCitations,
        },
      ],
      coverage: { ...fixture.coverage, completion: fixture.completion },
      contractVersion: 'opportunity-resume-fit-review/v4-complete-material',
      model: 'openai/gpt-6.1-sol',
    };
    const version =
      'opportunity-review-strength-verification/v2-partial-relevance';
    const verification = {
      version,
      model: 'jev-1.13.0',
      strengthClaimCount: 1,
      verifiedStrengthCount: 0,
      seniorityClaimCount: 1,
      verifiedSeniorityCount: 0,
      partialClaimCount: 1,
      verifiedPartialCount: 1,
      partialSupportedRequirementIds: ['material:c1'],
    };
    mocks.list.mockResolvedValue([
      {
        opportunityId: 'complete',
        contractVersion:
          'opportunity-review-strength-verification/v1-independent-jev',
        status: 'strength_verified',
      },
      {
        opportunityId: 'complete',
        contractVersion: version,
        status: 'strength_verified',
        assessmentJson: '{"verifiedStrengthCount":99}',
      },
    ]);
    mocks.readVerified.mockResolvedValue({
      contractVersion: version,
      mode: 'independent_strength_verification',
      model: 'jev-1.13.0',
      originalReview: effectiveReview,
      effectiveReview,
      verification,
      judgments: [
        {
          requirementId: 'material:c1',
          dimension: 'partial_relevance',
          probability: 0.95,
          verified: true,
        },
      ],
    });
    const opportunity = { id: 'complete' };
    const projections = await loadCurrentOpportunityResumeFitReviewProjections({
      opportunities: [opportunity],
      subject,
    });
    expect(mocks.readVerified).toHaveBeenCalledExactlyOnceWith(
      opportunity,
      subject,
      { version },
    );
    expect(mocks.read).not.toHaveBeenCalled();
    expect(projections.get('complete')).toMatchObject({
      evidenceFit: effectiveReview.evidenceFit,
      verification: {
        verifiedStrengthCount: 0,
        verifiedPartialCount: 1,
        partialSupportedRequirementIds: ['material:c1'],
      },
    });
    expect(
      projections.get('complete')?.verification?.partialSupportedRequirementIds,
    ).not.toBe(verification.partialSupportedRequirementIds);
  });

  it.each([
    'stale',
    'foreign',
    'duplicate_selected',
  ])('never falls back to V1 when selected V2 native proof fails (%s)', async () => {
    mocks.list.mockResolvedValue([
      {
        opportunityId: 'complete',
        contractVersion:
          'opportunity-review-strength-verification/v1-independent-jev',
        status: 'strength_verified',
      },
      {
        opportunityId: 'complete',
        contractVersion:
          'opportunity-review-strength-verification/v2-partial-relevance',
        status: 'strength_verified',
      },
    ]);
    mocks.readVerified.mockResolvedValue(undefined);
    const projections = await loadCurrentOpportunityResumeFitReviewProjections({
      opportunities: [{ id: 'complete' }],
      subject,
    });
    expect(projections.size).toBe(0);
    expect(projections.completeReviewStatuses.get('complete')).toBe('unknown');
    expect(mocks.readVerified).toHaveBeenCalledExactlyOnceWith(
      { id: 'complete' },
      subject,
      {
        version:
          'opportunity-review-strength-verification/v2-partial-relevance',
      },
    );
    expect(mocks.read).not.toHaveBeenCalled();
  });

  it('intentionally selects current attested verified Sol effective evidence without altering the original review', async () => {
    const originalProjection = completeReviewFixture();
    const effectiveProjection = completeReviewFixture({ uncertain: true });
    const originalReview = {
      ...originalProjection,
      coverage: {
        ...originalProjection.coverage,
        completion: originalProjection.completion,
      },
      contractVersion: 'opportunity-resume-fit-review/v4-complete-material',
      model: 'openai/gpt-6.1-sol',
    };
    const effectiveReview = {
      ...effectiveProjection,
      coverage: {
        ...effectiveProjection.coverage,
        completion: effectiveProjection.completion,
      },
      contractVersion: originalReview.contractVersion,
      model: originalReview.model,
    };
    const verification = {
      version: 'opportunity-review-strength-verification/v1-independent-jev',
      model: 'jev-1.13.0',
      requestId: 'actual-private-verifier',
      inputFingerprint: 'actual-input',
      originalReviewRequestId: 'actual-private-sol',
      strengthClaimCount: 1,
      verifiedStrengthCount: 0,
      seniorityClaimCount: 1,
      verifiedSeniorityCount: 0,
    };
    mocks.list.mockResolvedValue([
      {
        opportunityId: 'complete',
        contractVersion: originalReview.contractVersion,
        status: 'reviewed_with_unknowns',
      },
      {
        opportunityId: 'complete',
        contractVersion: verification.version,
        status: 'strength_verified',
      },
    ]);
    mocks.readVerified.mockResolvedValue({
      contractVersion: verification.version,
      mode: 'independent_strength_verification',
      model: verification.model,
      originalReview,
      effectiveReview,
      verification,
    });
    const opportunity = { id: 'complete' };
    const projected = await loadCurrentOpportunityResumeFitReviewProjections({
      opportunities: [opportunity],
      subject,
    });
    expect(mocks.readVerified).toHaveBeenCalledExactlyOnceWith(
      opportunity,
      subject,
      {
        version: 'opportunity-review-strength-verification/v1-independent-jev',
      },
    );
    expect(mocks.read).not.toHaveBeenCalled();
    expect(projected.completeReviewStatuses.get('complete')).toBe('current');
    expect(projected.get('complete')).toMatchObject({
      model: 'openai/gpt-6.1-sol',
      evidenceFit: effectiveReview.evidenceFit,
      requirements: effectiveReview.requirements,
      verification: {
        sourceStatus: 'current',
        version: verification.version,
        model: 'jev-1.13.0',
        strengthClaimCount: 1,
        verifiedStrengthCount: 0,
      },
    });
    expect(projected.get('complete')?.verification).not.toHaveProperty(
      'requestId',
    );
    expect(originalReview.requirements[0]?.status).toBe('strength');
  });

  it.each([
    'missing',
    'wrong_model',
    'stale',
    'foreign',
  ])('never falls back when an owned selected verifier is rejected (%s)', async (reason) => {
    mocks.list.mockResolvedValue([
      {
        opportunityId: 'complete',
        contractVersion:
          'opportunity-review-strength-verification/v1-independent-jev',
        status: 'strength_verified',
      },
    ]);
    mocks.readVerified.mockResolvedValue(
      reason === 'wrong_model'
        ? {
            contractVersion:
              'opportunity-review-strength-verification/v1-independent-jev',
            mode: 'independent_strength_verification',
            model: 'untrusted',
          }
        : undefined,
    );
    mocks.read.mockResolvedValue({ ...result, model: 'openai/gpt-6-luna' });
    const projections = await loadCurrentOpportunityResumeFitReviewProjections({
      opportunities: [{ id: 'complete' }],
      subject,
    });
    expect(projections.size).toBe(0);
    expect(projections.completeReviewStatuses.get('complete')).toBe('unknown');
    expect(mocks.readVerified).toHaveBeenCalledTimes(1);
    expect(mocks.read).not.toHaveBeenCalled();
  });

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
        'contractVersion in': [
          'opportunity-resume-fit-review/v2-catalog-aliases',
          'opportunity-resume-fit-review/v3-exact-quotes',
          'opportunity-resume-fit-review/v4-complete-material',
          'opportunity-review-strength-verification/v1-independent-jev',
          'opportunity-review-strength-verification/v2-partial-relevance',
        ],
        'status in': [
          'advisory',
          'reviewed_with_unknowns',
          'strength_verified',
        ],
      },
    });
    expect(projection).toEqual({
      version: 'opportunity-resume-fit-review-projection/v1',
      mode: 'advisory',
      resultContractVersion: result.contractVersion,
      sourceStatus: 'current',
      model: result.model,
      coverage: result.coverage,
      requirements: result.requirements,
    });
    expect(projection).not.toHaveProperty('requestId');
    expect(projection).not.toHaveProperty('fitScore');
    expect(projection?.requirements).not.toBe(result.requirements);
  });
  it('propagates the attested model instead of a saved JSON model claim', async () => {
    mocks.read.mockResolvedValue({ ...result, model: 'openai/gpt-6-luna' });
    const projections = await loadCurrentOpportunityResumeFitReviewProjections({
      opportunities: [
        {
          id: 'opportunity',
          model: 'openai/gpt-6.1-sol',
          assessmentJson: '{"model":"openai/gpt-6.1-sol"}',
        },
      ],
      subject,
    });
    expect(projections.get('opportunity')?.model).toBe('openai/gpt-6-luna');
  });
  it('locates historical V2 and new V3 saved rows while the selected attested reader decides currentness', async () => {
    mocks.list.mockImplementation(async (_name, _subject, options) => {
      expect(options.where['contractVersion in']).toEqual([
        'opportunity-resume-fit-review/v2-catalog-aliases',
        'opportunity-resume-fit-review/v3-exact-quotes',
        'opportunity-resume-fit-review/v4-complete-material',
        'opportunity-review-strength-verification/v1-independent-jev',
        'opportunity-review-strength-verification/v2-partial-relevance',
      ]);
      return [{ opportunityId: 'sol-v2' }, { opportunityId: 'luna-v3' }];
    });
    mocks.read.mockImplementation(async (record) =>
      record.id === 'sol-v2' ? result : undefined,
    );
    const projections = await loadCurrentOpportunityResumeFitReviewProjections({
      opportunities: [{ id: 'sol-v2' }, { id: 'luna-v3' }],
      subject,
    });
    expect(projections.get('sol-v2')?.model).toBe('openai/gpt-6.1-sol');
    expect(projections.has('luna-v3')).toBe(false);
    expect(mocks.read).toHaveBeenCalledTimes(2);
    mocks.read.mockImplementation(async (record) =>
      record.id === 'luna-v3'
        ? {
            ...result,
            contractVersion: 'opportunity-resume-fit-review/v3-exact-quotes',
            model: 'openai/gpt-6-luna',
          }
        : undefined,
    );
    const afterModelSelection =
      await loadCurrentOpportunityResumeFitReviewProjections({
        opportunities: [{ id: 'sol-v2' }, { id: 'luna-v3' }],
        subject,
      });
    expect(afterModelSelection.has('sol-v2')).toBe(false);
    expect(afterModelSelection.get('luna-v3')?.model).toBe('openai/gpt-6-luna');
  });
  it('requires native canonical QA acceptance before projecting a complete material review', async () => {
    mocks.list.mockResolvedValue([
      {
        opportunityId: 'complete',
        contractVersion: 'opportunity-resume-fit-review/v4-complete-material',
        status: 'reviewed_with_unknowns',
        model: 'openai/gpt-6.1-sol',
      },
    ]);
    const complete = {
      ...result,
      contractVersion: 'opportunity-resume-fit-review/v4-complete-material',
      mode: 'complete_material',
      model: 'openai/gpt-6-luna',
      evidenceFit: {
        kind: 'evidence_summary',
        supportedCriterionCount: 1,
        uncertainCriterionCount: 0,
        sourceUnknownCriterionCount: 0,
        sourceClassificationUnknownCount: 0,
        contextUnitCount: 0,
        consideredCriterionCount: 1,
        supportLowerBound: 1,
        status: 'supports_all_reviewed_criteria',
      },
      coverage: { ...result.coverage, consideredComplete: true },
    };
    mocks.read.mockResolvedValue(complete);
    const input = { opportunities: [{ id: 'complete' }], subject };
    expect(
      (await loadCurrentOpportunityResumeFitReviewProjections(input)).size,
    ).toBe(0);
    const completion = {
      status: 'reviewed_with_unknowns',
      consideredComplete: true,
      catalogClauseCount: 3,
      reviewedMaterialClauseCount: 2,
      possibleRequirementCount: 1,
      unprocessedClauseIds: [],
    };
    mocks.read.mockResolvedValue({
      ...complete,
      coverage: { ...complete.coverage, completion },
    });
    const accepted =
      await loadCurrentOpportunityResumeFitReviewProjections(input);
    expect(accepted.completeReviewStatuses.get('complete')).toBe('current');
    expect(accepted.get('complete')).toMatchObject({
      mode: 'complete_material',
      resultContractVersion: complete.contractVersion,
      completion,
      evidenceFit: complete.evidenceFit,
    });
    expect(mocks.read).toHaveBeenCalledWith(input.opportunities[0], subject, {
      version: complete.contractVersion,
      model: 'openai/gpt-6-luna',
    });
    mocks.read.mockResolvedValue({
      ...complete,
      coverage: {
        ...complete.coverage,
        completion: { ...completion, unprocessedClauseIds: ['missing'] },
      },
    });
    expect(
      (await loadCurrentOpportunityResumeFitReviewProjections(input)).size,
    ).toBe(0);
  });
  it.each([
    'wrong_model',
    'stale_source',
    'foreign_subject',
  ])('does not fall back to advisory material when the selected V4 proof fails (%s)', async (failure) => {
    mocks.list.mockResolvedValue([
      {
        opportunityId: 'complete',
        contractVersion: 'opportunity-resume-fit-review/v4-complete-material',
        status: 'reviewed_with_unknowns',
      },
    ]);
    mocks.read.mockResolvedValue(
      failure === 'wrong_model'
        ? {
            ...result,
            contractVersion:
              'opportunity-resume-fit-review/v4-complete-material',
            mode: 'complete_material',
          }
        : undefined,
    );
    const opportunity = { id: 'complete', resumeFitReviewProjection: result };
    const rejected = await loadCurrentOpportunityResumeFitReviewProjections({
      opportunities: [opportunity],
      subject,
    });
    expect(rejected.size).toBe(0);
    expect(rejected.completeReviewStatuses.get('complete')).toBe('unknown');
    expect(mocks.read).toHaveBeenCalledTimes(1);
    expect(mocks.read).toHaveBeenCalledWith(opportunity, subject, {
      version: 'opportunity-resume-fit-review/v4-complete-material',
      model: 'openai/gpt-6-luna',
    });
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
    const noSaved = await loadCurrentOpportunityResumeFitReviewProjections({
      opportunities,
      subject,
    });
    expect(noSaved.completeReviewStatuses.size).toBe(0);
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
