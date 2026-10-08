import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  staleSource: false,
  changedCandidate: false,
  candidateReads: 0,
  save: vi.fn(),
  enrich: vi.fn(async () => ({
    postings: 1,
    calls: 0,
    cacheHits: 0,
    failures: 0,
  })),
}));
const owner = { tenantId: 'tenant', userId: 'user', profileId: 'profile' };
vi.mock('./workspace-subject.js', async (original) => ({
  ...(await original<typeof import('./workspace-subject.js')>()),
  withVerifiedWorkspaceSubject: async (
    subject: unknown,
    fn: (subject: unknown) => Promise<unknown>,
  ) => fn(subject),
}));
vi.mock('./skill-vocabulary.js', () => ({
  refreshSkillVocabularyLookup: async () => 0,
}));
vi.mock('./resume-data.js', () => ({
  loadWorkspaceCandidateEvidence: async () => ({
    candidate: {
      title: '',
      authorizedWorkCountriesJson: '[]',
      citizenshipsJson: '[]',
      sponsorshipRequired: 'unknown',
    },
    evidence: [
      { id: 'skill', kind: 'skill', title: 'TypeScript', text: 'TypeScript' },
    ],
    fingerprint:
      state.changedCandidate && state.candidateReads++ > 0
        ? 'changed'
        : 'candidate',
    subject: { tenantId: 'tenant', userId: 'user', profileId: 'profile' },
  }),
}));
vi.mock('./private-workspace.js', () => ({
  listPrivateRecords: async () => [],
}));
vi.mock('./opportunity-match-cache.js', () => ({
  MAX_STAGE_THREE_POSTINGS: 25,
  enrichMatchEvidence: state.enrich,
}));
vi.mock('./opportunity-match-store.js', () => ({
  matchTransaction: async (fn: (db: unknown) => Promise<unknown>) =>
    fn({ url: 'sqlite::memory:' }),
  saveOwnedMatchRecord: state.save,
}));
vi.mock('./smrt.js', () => ({
  getCollection: async (name: string) => ({
    list: async (options: { where?: { id?: string } }) => {
      const posting = {
        id: 'job',
        status: 'found',
        sourceId: 'source',
        currentAnalysisId: 'analysis',
        sourceContentFingerprint:
          options.where?.id && state.staleSource
            ? 'changed'
            : 'source-fingerprint',
        sourceContentVersion: 1,
        requiredSkills: 'TypeScript',
        preferredSkills: '',
      };
      const rows =
        name === 'Opportunity'
          ? [posting]
          : name === 'OpportunityAnalysis'
            ? [
                {
                  id: 'analysis',
                  opportunityId: 'job',
                  sourceContentFingerprint: 'source-fingerprint',
                  sourceContentVersion: 1,
                  skillsJson: '[{"slug":"typescript","kind":"required"}]',
                  requirementsJson: '[]',
                },
              ]
            : name === 'Source'
              ? [{ id: 'source', isActive: true, publicListing: true }]
              : [];
      return rows.map((row) => ({ ...row, toJSON: () => row }));
    },
  }),
}));

import { refreshOpportunityMatches } from './opportunity-matching.js';

describe('private matching publication pipeline', () => {
  beforeEach(() => {
    state.staleSource = false;
    state.changedCandidate = false;
    state.candidateReads = 0;
    state.save.mockClear();
    state.enrich.mockClear();
  });
  it('publishes uncalibrated v3 ranks using complete owner/material/source provenance without paid enrichment', async () => {
    const result = await refreshOpportunityMatches(owner);
    expect(result.matches[0]).toMatchObject({
      id: 'job',
      score: 100,
      calibrated: false,
      scoreKind: 'coverage',
    });
    expect(state.enrich.mock.calls[0].at(-1)).toBe(false);
    expect(state.save).toHaveBeenCalledWith(
      'OpportunityRecommendationRank',
      owner,
      { opportunityId: 'job' },
      expect.objectContaining({
        projectionVersion: 'opportunity-recommendation-rank/v3',
        candidateMaterialFingerprint: result.materialFingerprint,
        sourceContentFingerprint: 'source-fingerprint',
        assessmentId: 'analysis',
        preferredSkillsSnapshot: '',
      }),
      expect.anything(),
    );
  });
  it('excludes a source that changes before the transactional publication fence', async () => {
    state.staleSource = true;
    expect((await refreshOpportunityMatches(owner)).matches).toEqual([]);
    expect(state.save).not.toHaveBeenCalled();
  });
  it('rejects a candidate change before any rank is committed', async () => {
    state.changedCandidate = true;
    await expect(refreshOpportunityMatches(owner)).rejects.toThrow(
      'Candidate changed',
    );
    expect(state.save).not.toHaveBeenCalled();
  });
});
