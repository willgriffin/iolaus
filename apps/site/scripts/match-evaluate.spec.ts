import { beforeEach, describe, expect, it, vi } from 'vitest';
const state = vi.hoisted(() => ({
  verify: vi.fn(),
  profile: vi.fn(),
  catalog: vi.fn(),
  cache: vi.fn(async () => ({
    cacheHits: 0,
    cacheLookups: 0,
    calls: 0,
    failures: 0,
    postings: 0,
  })),
}));
vi.mock('../src/lib/server/manifest-preload.js', () => ({}));
vi.mock('../src/lib/server/workspace-subject.js', () => ({
  verifyWorkspaceSubject: state.verify,
  resolveWorkspaceSubjectForProfile: state.profile,
  requireCandidateWorkspaceSubject: (subject: unknown) => subject,
  withVerifiedWorkspaceSubject: async (
    subject: unknown,
    fn: (subject: unknown) => Promise<unknown>,
  ) => fn(subject),
}));
vi.mock('../src/lib/server/skill-vocabulary.js', () => ({
  refreshSkillVocabularyLookup: async () => 0,
}));
vi.mock('../src/lib/server/resume-data.js', () => ({
  loadWorkspaceCandidateEvidence: async () => ({
    subject: { tenantId: 't', userId: 'u', profileId: 'p' },
    fingerprint: 'private-sentinel',
    candidate: {
      title: '',
      authorizedWorkCountriesJson: '[]',
      citizenshipsJson: '[]',
    },
    evidence: [],
  }),
}));
vi.mock('../src/lib/server/opportunity-matching.js', () => ({
  loadMatchingCatalog: state.catalog,
  loadMatchingSkillGraph: async () => new Map(),
  loadOwnedMatchSamples: async () => [
    {
      id: 'private-opportunity-id',
      at: 1,
      label: 1,
      features: [0.5],
      baseline: 0.5,
    },
  ],
}));
vi.mock('../src/lib/server/opportunity-recommendation-rank.js', () => ({
  listOwnedOpportunityRecommendationRanks: async () => [],
}));
vi.mock('../src/lib/server/opportunity-match-cache.js', () => ({
  enrichMatchEvidence: state.cache,
}));
import {
  parseMatchEvaluationArguments,
  runMatchEvaluation,
} from './match-evaluate.js';
const owner = { tenantId: 't', userId: 'u', profileId: 'p' };
describe('operator aggregate match evaluator', () => {
  beforeEach(() => {
    state.verify.mockReset().mockResolvedValue(owner);
    state.profile.mockReset().mockResolvedValue(owner);
    state.catalog.mockReset().mockResolvedValue([]);
    state.cache.mockClear();
  });
  it('requires explicit unique owner selectors', () => {
    expect(
      parseMatchEvaluationArguments([
        '--tenant-id',
        't',
        '--user-id',
        'u',
        '--profile-id',
        'p',
      ]),
    ).toEqual(owner);
    expect(() => parseMatchEvaluationArguments(['--user-id', 'u'])).toThrow();
    expect(() =>
      parseMatchEvaluationArguments([
        '--tenant-id',
        't',
        '--user-id',
        'u',
        '--user-id',
        'x',
      ]),
    ).toThrow();
  });
  it('verifies identity and selected profile before any private matching reads', async () => {
    state.verify.mockResolvedValue(null);
    await expect(runMatchEvaluation(owner)).rejects.toThrow(
      'active workspace member',
    );
    expect(state.catalog).not.toHaveBeenCalled();
    state.verify.mockResolvedValue(owner);
    state.profile.mockRejectedValue(new Error('foreign profile'));
    await expect(runMatchEvaluation(owner)).rejects.toThrow('foreign profile');
    expect(state.catalog).not.toHaveBeenCalled();
  });
  it('emits aggregate metrics without row IDs/evidence and never enables provider calls', async () => {
    const result = await runMatchEvaluation(owner);
    expect(result).toMatchObject({
      labeledCount: 1,
      calibrated: false,
      legacy: null,
      stage3: { providerCalls: 0, tokenSpend: 0 },
    });
    expect(JSON.stringify(result)).not.toContain('private-sentinel');
    expect(JSON.stringify(result)).not.toContain('private-opportunity-id');
    expect(state.cache.mock.calls[0].at(-1)).toBe(false);
  });
});
