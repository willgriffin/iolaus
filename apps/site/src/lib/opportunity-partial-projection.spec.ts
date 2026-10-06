import { describe, expect, it } from 'vitest';
import { getCurrentPartialOpportunityAssessmentProjection } from './opportunity-partial-projection';

const value = {
  version: 'opportunity-assessment-partial-projection/v1',
  mode: 'partial',
  sourceStatus: 'current',
  supportedCriterionCount: 0,
  criterionCount: 1,
  unresolvedSourceClauseCount: 2,
  requirements: [
    {
      id: 'criterion',
      text: 'Maintain APIs.',
      support: 'uncertain',
      postingCitations: [
        { excerpt: 'Maintain APIs.', clauseId: 'clause', start: 0, end: 13 },
      ],
      candidateCitations: [],
    },
  ],
};
describe('presentation-safe partial DTO', () => {
  it('preserves current zero support as distinct from unavailable proof', () => {
    expect(getCurrentPartialOpportunityAssessmentProjection(value)).toBe(value);
  });
  it.each([
    undefined,
    { ...value, sourceStatus: 'stale' },
    { ...value, supportedCriterionCount: 1 },
    { ...value, criterionCount: 0 },
    { ...value, unresolvedSourceClauseCount: -1 },
    { ...value, requirements: [null] },
  ])('rejects stale or inconsistent counts before display or shared ordering (%j)', (projection) => {
    expect(
      getCurrentPartialOpportunityAssessmentProjection(projection),
    ).toBeNull();
  });
});
