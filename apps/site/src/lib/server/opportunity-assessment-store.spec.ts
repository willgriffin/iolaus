import { describe, expect, it } from 'vitest';
import { projectOpportunityAssessment } from './opportunity-assessment-store.js';

const assessment = {
  candidateMaterialFingerprint: 'candidate-v1',
  claims: [
    {
      confidence: 0.95,
      dimension: 'location_access' as const,
      probability: 0.95,
      scope: 'candidate' as const,
      sourceKeys: ['posting-1', 'resume-1'],
      value: 'allowed',
    },
    {
      confidence: 0.95,
      dimension: 'authorization' as const,
      probability: 0.95,
      scope: 'posting' as const,
      sourceKeys: ['posting-1'],
      value: 'not_stated',
    },
  ],
  contractVersion: 'opportunity-assessment/v1' as const,
  coverage: {
    candidateTruncated: false,
    postingTruncated: false,
    requirementsTruncated: false,
  },
  fingerprint: 'assessment-v1',
  postingMaterial: {
    sourceContentFingerprint: 'posting-v1',
    sourceContentVersion: 1,
  },
  requirements: [],
};

describe('opportunity assessment projection', () => {
  it('does not expose source passages or candidate evidence to the UI', () => {
    const projection = projectOpportunityAssessment(
      assessment,
      {
        authorizedWorkCountries: [],
        citizenships: [{ code: 'CA', label: 'Canada' }],
        sponsorshipRequired: 'unknown',
        targetWorkCountry: { code: 'CA', label: 'Canada' },
      },
      [],
    );
    expect(projection).toEqual({
      conflicting: false,
      personalEligibility: 'eligible_without_sponsorship',
      ranking: { eligibilityPriority: 0, excluded: false, fitScore: 60 },
      reason: 'Eligible without sponsorship',
      sourceStatus: 'current',
    });
    expect(JSON.stringify(projection)).not.toContain('posting-1');
    expect(JSON.stringify(projection)).not.toContain('resume-1');
  });
});
