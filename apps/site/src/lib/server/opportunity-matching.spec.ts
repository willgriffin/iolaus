import { describe, expect, it } from 'vitest';
import { getMyOpportunityMatches } from './opportunity-matching.js';

describe('private opportunity matcher', () => {
  it('requires a candidate subject and ranks recall before bounding output independently of the stage-three cap', async () => {
    const reader = {
      loadCandidateSkills: async () => ['TypeScript'],
      listOpportunities: async ({ limit }: { limit: number }) =>
        Array.from({ length: limit }, (_, index) => ({
          id: String(index),
          skills: { required: ['TypeScript'] },
        })),
    };
    const matches = await getMyOpportunityMatches(
      { tenantId: 'tenant', userId: 'user', profileId: 'profile' },
      { limit: 100 },
      { reader },
    );
    expect(matches).toHaveLength(100);
    await expect(
      getMyOpportunityMatches(
        { tenantId: 'tenant', userId: 'user' },
        {},
        { reader },
      ),
    ).rejects.toThrow('candidate profile');
  });
});
