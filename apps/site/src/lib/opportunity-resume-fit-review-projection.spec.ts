import { describe, expect, it } from 'vitest';
import {
  advisoryRelevanceMean,
  completeReviewLabel,
  currentCitedSupport,
  evidenceFitLabel,
  getCurrentCompleteOpportunityReview,
} from './opportunity-resume-fit-review-projection';
import { completeReviewFixture } from './opportunity-resume-fit-review-projection.test-support';

describe('primary complete opportunity review', () => {
  it('includes unestablished criteria as zero rather than averaging only offered judgments', () => {
    expect(
      advisoryRelevanceMean([{ probability: 0.6 }, { probability: 0 }], 2),
    ).toBe(0.3);
    expect(advisoryRelevanceMean([{ probability: 0.6 }], 2)).toBeNull();
    expect(advisoryRelevanceMean([], 0)).toBeNull();
  });

  it('validates a continuous advisory mean without turning low relevance into a binary positive or candidate absence', () => {
    const fixture = completeReviewFixture({ uncertain: true });
    const verification = {
      sourceStatus: 'current',
      version: 'opportunity-review-strength-verification/v2-partial-relevance',
      model: 'jev-1.13.0',
      strengthClaimCount: 1,
      verifiedStrengthCount: 0,
      seniorityClaimCount: 1,
      verifiedSeniorityCount: 0,
      partialClaimCount: 1,
      verifiedPartialCount: 0,
      partialSupportedRequirementIds: [],
    };
    const advisoryRelevance = {
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
    };
    const review = {
      ...fixture,
      model: 'openai/gpt-6.1-sol',
      verification,
      advisoryRelevance,
      requirements: [
        {
          ...fixture.requirements[0],
          candidateCitations:
            completeReviewFixture().requirements[0]?.candidateCitations,
        },
      ],
    };
    const current = getCurrentCompleteOpportunityReview(review);
    expect(current && completeReviewLabel(current)).toBe('Advisory relevance');
    expect(current?.verification?.verifiedPartialCount).toBe(0);
    expect(current?.evidenceFit?.supportedCriterionCount).toBe(0);
    expect(currentCitedSupport({ resumeFitReviewProjection: review })).toEqual({
      supportedCriterionCount: 0,
      supportLowerBound: 0,
      advisoryRelevanceMean: 0.42,
    });
    for (const change of [
      { denominator: 2 },
      { weightedMean: 1 },
      {
        criterionProbabilityPairs: [
          {
            requirementId: 'foreign',
            probability: 0.42,
            evidenceStatus: 'cited',
          },
        ],
      },
      {
        criterionProbabilityPairs: [
          {
            requirementId: 'material:c1',
            probability: 2,
            evidenceStatus: 'cited',
          },
        ],
      },
      {
        criterionProbabilityPairs: [
          {
            requirementId: 'material:c1',
            probability: 0.42,
            evidenceStatus: 'unestablished',
          },
        ],
      },
    ]) {
      expect(
        getCurrentCompleteOpportunityReview({
          ...review,
          advisoryRelevance: { ...advisoryRelevance, ...change },
        }),
      ).toBeNull();
    }
    const unestablished = {
      ...review,
      verification: { ...verification, partialClaimCount: 0 },
      requirements: fixture.requirements,
      advisoryRelevance: {
        ...advisoryRelevance,
        weightedMean: 0,
        criterionProbabilityPairs: [
          {
            requirementId: 'material:c1',
            probability: 0,
            evidenceStatus: 'unestablished',
          },
        ],
      },
    };
    expect(
      getCurrentCompleteOpportunityReview(unestablished)?.advisoryRelevance
        ?.weightedMean,
    ).toBe(0);
    expect(
      getCurrentCompleteOpportunityReview({
        ...unestablished,
        advisoryRelevance: {
          ...unestablished.advisoryRelevance,
          weightedMean: 0.42,
          criterionProbabilityPairs:
            advisoryRelevance.criterionProbabilityPairs,
        },
      }),
    ).toBeNull();
  });

  it('keeps partial relevance disjoint from strict support, with the complete criteria denominator and honest label', () => {
    const source = completeReviewFixture({ uncertain: true });
    const verification = {
      sourceStatus: 'current',
      version: 'opportunity-review-strength-verification/v2-partial-relevance',
      model: 'jev-1.13.0',
      strengthClaimCount: 1,
      verifiedStrengthCount: 0,
      seniorityClaimCount: 1,
      verifiedSeniorityCount: 0,
      partialClaimCount: 1,
      verifiedPartialCount: 1,
      partialSupportedRequirementIds: ['material:c1'],
    };
    const review = {
      ...source,
      model: 'openai/gpt-6.1-sol',
      verification,
      requirements: [
        {
          ...source.requirements[0],
          candidateCitations:
            completeReviewFixture().requirements[0]?.candidateCitations,
        },
      ],
    };
    const current = getCurrentCompleteOpportunityReview(review);
    expect(current?.evidenceFit).toMatchObject({
      supportedCriterionCount: 0,
      uncertainCriterionCount: 1,
      consideredCriterionCount: 1,
      status: 'needs_evidence',
    });
    expect(current && completeReviewLabel(current)).toBe('Partial evidence');
    expect(currentCitedSupport({ resumeFitReviewProjection: review })).toEqual({
      supportedCriterionCount: 0,
      supportLowerBound: 0,
      partialSupportedCriterionCount: 1,
      partialSupportLowerBound: 1,
    });
    for (const change of [
      { partialSupportedRequirementIds: ['foreign'] },
      {
        partialSupportedRequirementIds: ['material:c1', 'material:c1'],
        verifiedPartialCount: 2,
      },
      { partialSupportedRequirementIds: [], verifiedPartialCount: 1 },
      { verifiedPartialCount: 2 },
    ]) {
      expect(
        getCurrentCompleteOpportunityReview({
          ...review,
          verification: { ...verification, ...change },
        }),
      ).toBeNull();
    }
    expect(
      getCurrentCompleteOpportunityReview({
        ...completeReviewFixture(),
        model: review.model,
        verification: {
          ...verification,
          verifiedStrengthCount: 1,
          verifiedSeniorityCount: 1,
        },
      }),
    ).toBeNull();
    expect(
      getCurrentCompleteOpportunityReview({
        ...review,
        verification: {
          ...verification,
          version:
            'opportunity-review-strength-verification/v1-independent-jev',
        },
      }),
    ).toBeNull();
  });

  it('accepts scoped current native Sol verification and uses downgraded effective evidence, rejecting self-claimed metadata', () => {
    const verification = {
      sourceStatus: 'current',
      version: 'opportunity-review-strength-verification/v1-independent-jev',
      model: 'jev-1.13.0',
      strengthClaimCount: 1,
      verifiedStrengthCount: 0,
      seniorityClaimCount: 1,
      verifiedSeniorityCount: 0,
    };
    const review = {
      ...completeReviewFixture({ uncertain: true }),
      model: 'openai/gpt-6.1-sol',
      verification,
    };
    expect(
      getCurrentCompleteOpportunityReview(review)?.evidenceFit,
    ).toMatchObject({ supportedCriterionCount: 0, status: 'needs_evidence' });
    expect(currentCitedSupport({ resumeFitReviewProjection: review })).toEqual({
      supportedCriterionCount: 0,
      supportLowerBound: 0,
    });
    expect(
      getCurrentCompleteOpportunityReview({
        ...review,
        verification: undefined,
      }),
    ).toBeNull();
    for (const change of [
      { sourceStatus: 'stale' },
      { model: 'untrusted' },
      { version: 'unknown' },
      { verifiedStrengthCount: 1 },
      { verifiedSeniorityCount: 2 },
    ]) {
      expect(
        getCurrentCompleteOpportunityReview({
          ...review,
          verification: { ...verification, ...change },
        }),
      ).toBeNull();
    }
  });

  it('uses current native evidence counts for support, uncertainty and zero-denominator context', () => {
    const supported = getCurrentCompleteOpportunityReview(
      completeReviewFixture(),
    );
    expect(supported?.evidenceFit).toMatchObject({
      supportedCriterionCount: 1,
      consideredCriterionCount: 1,
      supportLowerBound: 1,
      status: 'supports_all_reviewed_criteria',
    });
    expect(
      supported?.evidenceFit && evidenceFitLabel(supported.evidenceFit),
    ).toBe('All reviewed criteria supported');
    expect(
      getCurrentCompleteOpportunityReview(
        completeReviewFixture({ sourceUnknown: true }),
      )?.evidenceFit,
    ).toMatchObject({
      sourceUnknownCriterionCount: 1,
      status: 'needs_evidence',
    });
    expect(
      getCurrentCompleteOpportunityReview(
        completeReviewFixture({ context: true }),
      )?.evidenceFit,
    ).toMatchObject({
      contextUnitCount: 1,
      consideredCriterionCount: 0,
      supportLowerBound: null,
      status: 'no_applicant_criteria',
    });
  });
  it('rejects forged stronger counts, stale review, or an advisory contract relabeled complete', () => {
    const review = completeReviewFixture({ sourceUnknown: true });
    expect(
      getCurrentCompleteOpportunityReview({
        ...review,
        evidenceFit: completeReviewFixture().evidenceFit,
      }),
    ).toBeNull();
    expect(
      getCurrentCompleteOpportunityReview({ ...review, sourceStatus: 'stale' }),
    ).toBeNull();
    expect(
      getCurrentCompleteOpportunityReview({
        ...review,
        resultContractVersion: 'opportunity-resume-fit-review/v3-exact-quotes',
      }),
    ).toBeNull();
  });
  it('keeps current zero support rankable and never revives partial support through stale complete data', () => {
    const review = completeReviewFixture({ uncertain: true });
    expect(currentCitedSupport({ resumeFitReviewProjection: review })).toEqual({
      supportedCriterionCount: 0,
      supportLowerBound: 0,
    });
    expect(
      currentCitedSupport({
        resumeFitReviewProjection: { ...review, sourceStatus: 'stale' },
      }),
    ).toBeNull();
    expect(
      currentCitedSupport({
        completeReviewStatus: 'unknown',
        resumeFitReviewProjection: completeReviewFixture(),
      }),
    ).toBeNull();
  });
});
