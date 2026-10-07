import { describe, expect, it } from 'vitest';
import {
  getMyOpportunityMatches,
  MAX_STAGE_THREE_POSTINGS,
} from './opportunity-matching.js';

describe('private opportunity matcher', () => {
  it('requires a candidate subject and bounds every refresh to the stage-three cap', async () => {
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
    expect(matches).toHaveLength(MAX_STAGE_THREE_POSTINGS);
    await expect(
      getMyOpportunityMatches(
        { tenantId: 'tenant', userId: 'user' },
        {},
        { reader },
      ),
    ).rejects.toThrow('candidate profile');
  });
});
