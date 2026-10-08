import type { WorkspaceCandidateEvidence } from './resume-data.js';
export function candidateFixture(): WorkspaceCandidateEvidence {
  return {
    candidate: {
      authorizedWorkCountriesJson: '[]',
      citizenshipsJson: '[]',
      factsJson: '{}',
      location: '',
      preferencesJson: '{}',
      residenceCountryJson: '',
      sponsorshipRequired: 'unknown',
      summary: '',
      targetWorkCountryJson: '',
      title: 'Senior engineer',
      workAuthorization: '',
    },
    evidence: [
      {
        id: 'skill:ts',
        kind: 'skill',
        text: 'TypeScript',
        title: 'TypeScript',
      },
    ],
    fingerprint: 'candidate-v1',
    subject: { tenantId: 't', userId: 'u', profileId: 'p' },
  };
}
