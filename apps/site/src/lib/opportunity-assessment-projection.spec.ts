import { describe, expect, it } from 'vitest';
import {
  assessmentCoverageMessages,
  compareAssessmentEligibility,
  getOpportunityAssessmentProjection,
  matchesAssessmentEligibility,
} from './opportunity-assessment-projection';

describe('opportunity assessment projection', () => {
  it('describes uncertain requirement completeness without claiming wire truncation', () => {
    const projection = getOpportunityAssessmentProjection({
      sourceStatus: 'current',
      eligibilityBucket: 'eligible',
      ranking: { eligibilityPriority: 0, fitScore: 88 },
      matchReadiness: 'needs_evidence',
      coverage: {
        candidateTruncated: false,
        postingTruncated: false,
        requirementsTruncated: true,
        requirementCount: 17,
      },
    });
    expect(projection.matchReadiness).toBe('needs_evidence');
    expect(assessmentCoverageMessages(projection)).toEqual([
      'Role requirements may be incomplete.',
    ]);
  });
  it('only accepts an explicit current safe projection', () => {
    const assessment = {
      eligibilityBucket: 'eligible',
      sourceStatus: 'current',
      ranking: { eligibilityPriority: 0, fitScore: 84 },
      reason: 'Safe summary',
    };
    expect(getOpportunityAssessmentProjection(assessment)).toMatchObject({
      buckets: ['eligible'],
      fitScore: 84,
    });
    expect(
      getOpportunityAssessmentProjection({
        ...assessment,
        sourceStatus: 'stale',
      }).buckets,
    ).toEqual(['unknown']);
    expect(
      getOpportunityAssessmentProjection({
        eligibilityBucket: 'bad',
        sourceStatus: 'current',
      }).buckets,
    ).toEqual(['unknown']);
  });
  it('filters OR buckets and ranks priority then fit score', () => {
    const sponsor = {
      eligibilityBucket: 'sponsorship_possible',
      sourceStatus: 'current',
      ranking: { eligibilityPriority: 1, fitScore: 99 },
    };
    const eligible = {
      eligibilityBucket: 'eligible',
      sourceStatus: 'current',
      ranking: { eligibilityPriority: 0, fitScore: 1 },
    };
    expect(
      matchesAssessmentEligibility(sponsor, [
        'location_restriction',
        'sponsorship_possible',
      ]),
    ).toBe(true);
    expect(compareAssessmentEligibility(eligible, sponsor)).toBeLessThan(0);
  });

  it('uses numeric match only to break ties between two assessable projections', () => {
    const projection = {
      sourceStatus: 'current',
      eligibilityBucket: 'eligible',
      matchReadiness: 'assessable',
      coverage: {
        candidateTruncated: false,
        postingTruncated: false,
        requirementsTruncated: false,
        requirementCount: 4,
      },
      ranking: { eligibilityPriority: 0, fitScore: 88 },
    };
    const lowerFit = {
      ...projection,
      ranking: { eligibilityPriority: 0, fitScore: 15 },
    };
    expect(compareAssessmentEligibility(projection, lowerFit)).toBeLessThan(0);
    expect(
      compareAssessmentEligibility(projection, {
        ...lowerFit,
        matchReadiness: 'needs_evidence',
      }),
    ).toBe(0);
    expect(
      compareAssessmentEligibility(
        { ...projection, matchReadiness: 'needs_extraction' },
        lowerFit,
      ),
    ).toBe(0);
  });

  it.each([
    {
      requirementCount: 0,
      candidateTruncated: false,
      postingTruncated: false,
      requirementsTruncated: false,
    },
    {
      requirementCount: 4,
      candidateTruncated: true,
      postingTruncated: false,
      requirementsTruncated: false,
    },
    {
      requirementCount: 4,
      candidateTruncated: false,
      postingTruncated: true,
      requirementsTruncated: false,
    },
    {
      requirementCount: 4,
      candidateTruncated: false,
      postingTruncated: false,
      requirementsTruncated: true,
    },
  ])('rejects assessable readiness contradicted by coverage (%j)', (coverage) => {
    const projection = getOpportunityAssessmentProjection({
      sourceStatus: 'current',
      eligibilityBucket: 'eligible',
      ranking: { eligibilityPriority: 0, fitScore: 88 },
      matchReadiness: 'assessable',
      coverage,
    });
    expect(projection.matchReadiness).toBe('unknown');
    expect(projection.buckets).toEqual(['eligible']);
    expect(projection.sourceStatus).toBe('current');
  });

  it('takes readiness from the server and fails closed for absent or malformed coverage', () => {
    const assessment = {
      sourceStatus: 'current',
      eligibilityBucket: 'eligible',
      ranking: { eligibilityPriority: 0, fitScore: 88 },
      matchReadiness: 'needs_extraction',
      coverage: {
        candidateTruncated: false,
        postingTruncated: false,
        requirementsTruncated: false,
        requirementCount: 4,
      },
    };
    // The UI consumes the server decision even when the count alone would
    // suggest another readiness state; it never recreates assessment rules.
    expect(getOpportunityAssessmentProjection(assessment).matchReadiness).toBe(
      'needs_extraction',
    );
    expect(
      getOpportunityAssessmentProjection({ ...assessment, coverage: undefined })
        .matchReadiness,
    ).toBe('unknown');
    expect(
      getOpportunityAssessmentProjection({
        ...assessment,
        coverage: { ...assessment.coverage, candidateTruncated: 'false' },
      }).matchReadiness,
    ).toBe('unknown');
    expect(
      getOpportunityAssessmentProjection({
        ...assessment,
        matchReadiness: 'new_provider_value',
      }).matchReadiness,
    ).toBe('unknown');
    expect(getOpportunityAssessmentProjection(assessment).buckets).toEqual([
      'eligible',
    ]);
  });
});
