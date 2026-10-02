import { describe, expect, it } from 'vitest';
import {
  compareAssessmentEligibility,
  getOpportunityAssessmentProjection,
  matchesAssessmentEligibility,
} from './opportunity-assessment-projection';

describe('opportunity assessment projection', () => {
  it('only accepts an explicit current safe projection', () => {
    const assessment = {
      personalEligibility: 'eligible_without_sponsorship',
      sourceStatus: 'current',
      ranking: { eligibilityPriority: 0, fitScore: 84 },
      reason: 'Safe summary',
    };
    expect(getOpportunityAssessmentProjection(assessment)).toMatchObject({
      buckets: ['eligible_without_sponsorship'],
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
        personalEligibility: 'bad',
        sourceStatus: 'current',
      }).buckets,
    ).toEqual(['unknown']);
  });
  it('filters OR buckets and ranks priority then fit score', () => {
    const sponsor = {
      personalEligibility: 'sponsorship_possible',
      sourceStatus: 'current',
      ranking: { eligibilityPriority: 1, fitScore: 99 },
    };
    const eligible = {
      personalEligibility: 'eligible_without_sponsorship',
      sourceStatus: 'current',
      ranking: { eligibilityPriority: 0, fitScore: 1 },
    };
    expect(
      matchesAssessmentEligibility(sponsor, [
        'incompatible',
        'sponsorship_possible',
      ]),
    ).toBe(true);
    expect(compareAssessmentEligibility(eligible, sponsor)).toBeLessThan(0);
  });
});
