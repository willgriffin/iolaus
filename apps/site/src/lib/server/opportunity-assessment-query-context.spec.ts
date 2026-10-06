import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  candidate: vi.fn(),
  records: vi.fn(),
  scope: vi.fn(),
}));
vi.mock('./resume-data.js', () => ({
  loadWorkspaceCandidateEvidence: mocks.candidate,
}));
vi.mock('./private-workspace.js', () => ({
  createPrivateRecord: vi.fn(),
  listPrivateRecords: mocks.records,
}));
vi.mock('./screening-question-assessment-service.js', () => ({
  loadCurrentScreeningQuestionRecommendationScope: mocks.scope,
}));

import { loadOpportunityAssessmentQueryContext } from './opportunity-assessment-store.js';

describe('bounded opportunity query material', () => {
  beforeEach(() => vi.clearAllMocks());

  it('shares one owned candidate read between legacy and indexed material fingerprints', async () => {
    const subject = {
      tenantId: 'tenant',
      userId: 'owner',
      profileId: 'profile',
    };
    const evidence = {
      fingerprint: 'candidate-semantic',
      profile: {},
      occurrences: [],
    };
    const scope = {
      questionScreeningEnabled: true,
      candidateMaterialFingerprint: 'screening-candidate',
      questionSetFingerprint: 'questions',
    };
    mocks.candidate.mockResolvedValue(evidence);
    mocks.records.mockResolvedValue([]);
    mocks.scope.mockImplementation(async (owned, dependencies) => {
      expect(owned).toBe(subject);
      expect(await dependencies.loadCandidate()).toBe(evidence);
      return scope;
    });
    const context = await loadOpportunityAssessmentQueryContext(subject);
    expect(mocks.candidate).toHaveBeenCalledExactlyOnceWith(subject);
    expect(mocks.records).toHaveBeenCalledTimes(1);
    expect(mocks.scope).toHaveBeenCalledTimes(1);
    expect(context.assessmentCandidateMaterialFingerprint).toBe(
      evidence.fingerprint,
    );
    expect(context.questionRecommendationScope).toBe(scope);
  });
});
