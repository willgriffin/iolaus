import { describe, expect, it } from 'vitest';
import {
  isCurrentOpportunityAssessmentRecord,
  projectOpportunityAssessment,
} from './opportunity-assessment-store.js';

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
  contractVersion: 'opportunity-assessment/v4' as const,
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
        authorizedWorkCountries: [
          {
            country: { code: 'CA', label: 'Canada' },
            scope: 'country',
          },
        ],
        citizenships: [{ code: 'CA', label: 'Canada' }],
        sponsorshipRequired: 'unknown',
        targetWorkCountry: { code: 'CA', label: 'Canada' },
      },
      [],
    );
    expect(projection).toEqual({
      conflicting: false,
      coverage: {
        candidateTruncated: false,
        postingTruncated: false,
        requirementCount: 0,
        requirementsTruncated: false,
      },
      eligibilityBucket: 'eligible',
      matchReadiness: 'needs_extraction',
      personalEligibility: 'eligible_without_sponsorship',
      ranking: { eligibilityPriority: 0, excluded: false, fitScore: 60 },
      reason: 'Needs structured role requirements before matching.',
      sourceStatus: 'current',
    });
    expect(JSON.stringify(projection)).not.toContain('posting-1');
    expect(JSON.stringify(projection)).not.toContain('resume-1');
  });

  it('hides a projection after profile country, authorization, or evidence material changes', () => {
    const row = {
      candidateMaterialFingerprint: 'profile-ca-authorization-none-evidence-a',
      sourceContentFingerprint: 'posting-v1',
      sourceContentVersion: 1,
    };
    const current = {
      candidateMaterialFingerprint: row.candidateMaterialFingerprint,
      sourceContentFingerprint: 'posting-v1',
      sourceContentVersion: 1,
    };
    expect(isCurrentOpportunityAssessmentRecord(row, current)).toBe(true);

    // All three inputs are folded into the verified evidence fingerprint by
    // loadWorkspaceCandidateEvidence; a changed fingerprint excludes the old
    // result until a bounded assessment refresh stores a replacement.
    for (const changedCandidateMaterial of [
      'profile-us-authorization-none-evidence-a',
      'profile-ca-authorization-ca-evidence-a',
      'profile-ca-authorization-none-evidence-b',
    ]) {
      expect(
        isCurrentOpportunityAssessmentRecord(row, {
          ...current,
          candidateMaterialFingerprint: changedCandidateMaterial,
        }),
      ).toBe(false);
    }
  });

  it('reranks the same stored assessment when a local preference changes', () => {
    const candidate = {
      authorizedWorkCountries: [
        {
          country: { code: 'CA', label: 'Canada' },
          scope: 'country' as const,
        },
      ],
      citizenships: [{ code: 'CA', label: 'Canada' }],
      sponsorshipRequired: 'unknown' as const,
      targetWorkCountry: { code: 'CA', label: 'Canada' },
    };
    const baseline = projectOpportunityAssessment(assessment, candidate, []);
    const reranked = projectOpportunityAssessment(assessment, candidate, [
      {
        category: 'scoring',
        isHardFilter: false,
        name: 'Avoid uncertain remote arrangements',
        ruleJson: JSON.stringify({
          dimension: 'location_access',
          values: ['allowed'],
        }),
        weight: -25,
      },
    ]);

    expect(reranked.ranking.fitScore).toBe(baseline.ranking.fitScore - 25);
    expect(reranked.ranking.eligibilityPriority).toBe(
      baseline.ranking.eligibilityPriority,
    );
  });
});
