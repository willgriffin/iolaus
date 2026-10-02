import { describe, expect, it } from 'vitest';
import {
  compareAssessmentEligibility,
  getOpportunityAssessmentProjection,
  matchesAssessmentEligibility,
} from './opportunity-assessment-projection';

describe('opportunity assessment projection', () => {
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
});
