import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { prepareOpportunityAssessment } from './opportunity-assessment.js';
import {
  assessmentDecisionOutputTokenCeiling,
  evaluateOpportunityAssessment,
} from './opportunity-assessment-decision-provider.js';

const mocks = vi.hoisted(() => ({
  capabilities: vi.fn(),
  decide: vi.fn(),
  execute: vi.fn(),
  getAI: vi.fn(),
}));

vi.mock('@happyvertical/ai', () => ({ getAI: mocks.getAI }));
vi.mock('./opportunity-intelligence-governance.js', () => ({
  executeGovernedOpportunityIntelligenceRequest: mocks.execute,
}));

const prepared = prepareOpportunityAssessment({
  candidate: {
    authorizedWorkCountries: [],
    citizenships: [{ code: 'CA', label: 'Canada' }],
    sponsorshipRequired: 'unknown',
    targetWorkCountry: { code: 'CA', label: 'Canada' },
  },
  candidateMaterialFingerprint: 'candidate-v1',
  candidateSources: [
    {
      id: 'candidate-1',
      kind: 'achievement',
      text: 'Platform work',
      title: 'Platform',
    },
  ],
  postingMaterial: {
    sourceContentFingerprint: 'posting-v1',
    sourceContentVersion: 1,
  },
  postingSources: [
    {
      id: 'posting-1',
      kind: 'location',
      text: 'Remote Canada',
      title: 'Location',
    },
  ],
});

const workspaceSubject = {
  profileId: 'profile-1',
  tenantId: 'tenant-1',
  userId: 'user-1',
};

function answers() {
  const result: Record<string, unknown> = {};
  for (const key of Object.keys(prepared.request.questions)) {
    if (key.endsWith('_explicit'))
      result[key] = { type: 'predicate', probability: 0.1 };
    else if (key.endsWith('_posting_source'))
      result[key] = {
        type: 'choice',
        choice: 'uncertain',
        confidence: 0.9,
        probabilities: {},
      };
    else if (key.endsWith('_source'))
      result[key] = {
        type: 'choice',
        choice: 'uncertain',
        confidence: 0.9,
        probabilities: {},
      };
    else if (key.endsWith('_support'))
      result[key] = {
        type: 'choice',
        choice: 'uncertain',
        confidence: 0.9,
        probabilities: {},
      };
    else if (key.endsWith('_importance'))
      result[key] = {
        type: 'choice',
        choice: 'uncertain',
        confidence: 0.9,
        probabilities: {},
      };
    else
      result[key] = {
        type: 'choice',
        choice: key === 'experience_fit_value' ? 'uncertain' : 'unknown',
        confidence: 0.9,
        probabilities: {},
      };
  }
  return result;
}

describe('opportunity assessment decision provider', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.stubEnv('OPPORTUNITY_ASSESSMENT_DECISIONS_ENABLED', 'true');
    vi.stubEnv('TYPESAFE_API_KEY', 'test-key');
    vi.stubEnv(
      'OPPORTUNITY_SKILL_DECISION_INPUT_COST_MICROS_PER_MILLION',
      '1000',
    );
    vi.stubEnv(
      'OPPORTUNITY_SKILL_DECISION_OUTPUT_COST_MICROS_PER_MILLION',
      '2000',
    );
    mocks.getAI.mockResolvedValue({
      decide: mocks.decide,
      getCapabilities: mocks.capabilities,
    });
    mocks.capabilities.mockResolvedValue({ decisions: true });
    mocks.execute.mockImplementation(async (options) => options.invoke());
    mocks.decide.mockResolvedValue({
      answers: answers(),
      model: 'jev-test',
      provenance: { model: 'jev-test', provider: 'typesafe' },
      usage: { completionTokens: 2, promptTokens: 10, totalTokens: 12 },
    });
  });

  afterEach(() => vi.unstubAllEnvs());

  it('uses the governed JEV path without exposing the subject identity', async () => {
    await evaluateOpportunityAssessment(prepared, {
      agentRunId: 'run-1',
      contentFingerprint: 'posting-v1',
      opportunityId: 'opportunity-1',
      subjectFingerprint: 'opaque-subject-v1',
      workspaceSubject,
    });
    expect(mocks.execute).toHaveBeenCalledWith(
      expect.objectContaining({
        identity: expect.objectContaining({
          feature: 'opportunity-assessment',
          inputFingerprint: expect.not.stringContaining('opaque-subject-v1'),
        }),
        workspaceSubject,
      }),
    );
    expect(mocks.decide).toHaveBeenCalledWith(
      prepared.request,
      expect.objectContaining({ timeout: 30000 }),
    );
  });

  it('reserves from the typed decision response shape, not the legacy skill cap', () => {
    expect(
      assessmentDecisionOutputTokenCeiling(prepared.request),
    ).toBeGreaterThan(1_024);
  });

  it('does not invoke a provider while disabled', async () => {
    vi.stubEnv('OPPORTUNITY_ASSESSMENT_DECISIONS_ENABLED', 'false');
    await expect(
      evaluateOpportunityAssessment(prepared, {
        agentRunId: 'run-1',
        contentFingerprint: 'posting-v1',
        opportunityId: 'opportunity-1',
        subjectFingerprint: 'opaque-subject-v1',
        workspaceSubject,
      }),
    ).resolves.toBeUndefined();
    expect(mocks.getAI).not.toHaveBeenCalled();
  });

  it('requires a reservation owner and opaque subject identity', async () => {
    await expect(
      evaluateOpportunityAssessment(prepared, {
        contentFingerprint: 'posting-v1',
        opportunityId: 'opportunity-1',
        subjectFingerprint: 'opaque-subject-v1',
        workspaceSubject,
      }),
    ).rejects.toThrow('AgentRun');
    await expect(
      evaluateOpportunityAssessment(prepared, {
        agentRunId: 'run-1',
        contentFingerprint: 'posting-v1',
        opportunityId: 'opportunity-1',
        subjectFingerprint: '',
        workspaceSubject,
      }),
    ).rejects.toThrow('subject fingerprint');
  });
});
