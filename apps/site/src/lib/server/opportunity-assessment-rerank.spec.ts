import { describe, expect, it, vi } from 'vitest';

const fixtures = vi.hoisted(() => {
  const assessmentRow: Record<string, unknown> & {
    save: ReturnType<typeof vi.fn>;
  } = {
    assessmentJson: JSON.stringify({
      candidateMaterialFingerprint: 'candidate-v1',
      claims: [
        {
          confidence: 0.9,
          dimension: 'location_access',
          probability: 0.9,
          scope: 'candidate',
          sourceKeys: ['posting-1'],
          value: 'allowed',
        },
        {
          confidence: 0.9,
          dimension: 'authorization',
          probability: 0.9,
          scope: 'posting',
          sourceKeys: ['posting-1'],
          value: 'not_stated',
        },
      ],
      contractVersion: 'opportunity-assessment/v1',
      coverage: {},
      fingerprint: 'assessment-v1',
      postingMaterial: {
        sourceContentFingerprint: 'posting-v1',
        sourceContentVersion: 1,
      },
      requirements: [],
    }),
    candidateMaterialFingerprint: 'candidate-v1',
    eligibilityBucket: 'eligible',
    eligibilityPriority: 0,
    excluded: false,
    fitScore: 60,
    preferencesFingerprint: 'old-preferences',
    projectionJson: '{}',
    save: vi.fn(async () => {}),
  };
  const preferences = [
    {
      active: true,
      category: 'scoring',
      isHardFilter: false,
      name: 'Remote preference',
      ruleJson: JSON.stringify({
        dimension: 'location_access',
        values: ['allowed'],
      }),
      weight: 20,
    },
  ];
  return { assessmentRow, preferences };
});

vi.mock('./private-workspace.js', () => ({
  listPrivateRecords: vi.fn(async (className: string) =>
    className === 'PreferenceRule'
      ? fixtures.preferences
      : className === 'OpportunityAssessment'
        ? [fixtures.assessmentRow]
        : [],
  ),
}));

vi.mock('./resume-data.js', () => ({
  loadWorkspaceCandidateEvidence: vi.fn(async (subject: unknown) => ({
    candidate: {
      authorizedWorkCountriesJson:
        '[{"country":{"code":"CA","label":"Canada"},"scope":"country"}]',
      citizenshipsJson: '[{"code":"CA","label":"Canada"}]',
      residenceCountryJson: '{}',
      sponsorshipRequired: 'unknown',
      targetWorkCountryJson: '{"code":"CA","label":"Canada"}',
    },
    evidence: [],
    fingerprint: 'candidate-v1',
    subject,
  })),
}));

import { refreshOpportunityAssessmentProjections } from './opportunity-assessment-store.js';

describe('opportunity assessment local rerank', () => {
  it('materializes a preference change without a provider call', async () => {
    const result = await refreshOpportunityAssessmentProjections({
      subject: {
        profileId: 'profile-1',
        tenantId: 'tenant-1',
        userId: 'user-1',
      },
    });

    expect(result).toEqual({ refreshed: 1, skipped: 0 });
    expect(fixtures.assessmentRow.fitScore).toBe(80);
    expect(fixtures.assessmentRow.preferencesFingerprint).not.toBe(
      'old-preferences',
    );
    expect(fixtures.assessmentRow.save).toHaveBeenCalledOnce();
  });
});
