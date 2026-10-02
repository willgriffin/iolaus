import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { prepareOpportunityAssessment } from './opportunity-assessment.js';
import {
  assessmentDecisionOutputTokenCeiling,
  evaluateOpportunityAssessment,
  OPPORTUNITY_ASSESSMENT_MAX_REQUEST_BYTES,
  preflightOpportunityAssessmentRequest,
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
  requirements: [{ id: 'requirement-1', text: 'Platform work' }],
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
    if (prepared.request.questions[key].type === 'predicate')
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
  it('preflights exact UTF-8 bytes and declines oversized complete content before reservation', async () => {
    const oversized = prepareOpportunityAssessment({
      candidate: prepared.candidate,
      candidateMaterialFingerprint: 'full-candidate',
      candidateSources: [
        {
          id: 'unicode',
          kind: 'achievement',
          title: 'Complete narrative',
          text: 'é'.repeat(40_000),
        },
      ],
      postingMaterial: prepared.postingMaterial,
      postingSources: prepared.postingSources,
      requirements: [{ id: 'r', text: 'Platform work' }],
    });
    const preflight = preflightOpportunityAssessmentRequest(oversized);
    expect(preflight.requestBytes).toBe(
      Buffer.byteLength(JSON.stringify(oversized.request), 'utf8'),
    );
    expect(preflight.requestBytes).toBeGreaterThan(
      OPPORTUNITY_ASSESSMENT_MAX_REQUEST_BYTES,
    );
    expect(preflight).toMatchObject({ fits: false, reason: 'request_bytes' });
    expect(oversized.coverage.candidateTruncated).toBe(false);
    await expect(
      evaluateOpportunityAssessment(oversized, {
        agentRunId: 'run',
        contentFingerprint: 'posting',
        opportunityId: 'opportunity',
        subjectFingerprint: 'subject',
        workspaceSubject,
      }),
    ).rejects.toThrow('Complete opportunity assessment request');
    expect(mocks.execute).not.toHaveBeenCalled();
    expect(mocks.getAI).not.toHaveBeenCalled();
  });

  it('declines an excessive typed output reservation even when the request bytes fit', async () => {
    const outputHeavy = {
      ...prepared,
      request: {
        state: {},
        questions: Object.fromEntries(
          Array.from({ length: 70 }, (_, index) => [
            `q${index}`,
            {
              type: 'choice' as const,
              instructions: 'Select evidence',
              criteria: Object.fromEntries(
                Array.from({ length: 28 }, (_, criterion) => [
                  `c${criterion}`,
                  null,
                ]),
              ),
            },
          ]),
        ),
      },
    };
    expect(preflightOpportunityAssessmentRequest(outputHeavy)).toMatchObject({
      fits: false,
      reason: 'output_reservation',
    });
    await expect(
      evaluateOpportunityAssessment(outputHeavy, {
        agentRunId: 'run',
        contentFingerprint: 'posting',
        opportunityId: 'opportunity',
        subjectFingerprint: 'subject',
        workspaceSubject,
      }),
    ).rejects.toThrow('response reservation');
    expect(mocks.execute).not.toHaveBeenCalled();
    expect(mocks.getAI).not.toHaveBeenCalled();
  });
  it('requires extraction before any assessment reservation or provider call', async () => {
    await expect(
      evaluateOpportunityAssessment(
        { ...prepared, requirements: [] },
        {
          agentRunId: 'run',
          contentFingerprint: 'posting',
          opportunityId: 'opportunity',
          subjectFingerprint: 'subject',
          workspaceSubject,
        },
      ),
    ).rejects.toThrow('Extract structured role requirements');
    expect(mocks.execute).not.toHaveBeenCalled();
    expect(mocks.getAI).not.toHaveBeenCalled();
  });
  it('budgets a rich complete source catalog with thirty requirements without losing facts', () => {
    const full = prepareOpportunityAssessment({
      candidate: prepared.candidate,
      candidateMaterialFingerprint: 'rich',
      candidateSources: Array.from({ length: 150 }, (_, index) => ({
        id: `private-original-identifier-${index}`,
        kind:
          index === 0
            ? 'candidate_profile'
            : index >= 148
              ? 'skill'
              : 'achievement',
        title: 'Evidence',
        text:
          index === 148
            ? 'Engineering'
            : index === 149
              ? 'Leadership'
              : `Engineering leadership evidence ${index}. ${'Complete private narrative. '.repeat(4)}`,
      })),
      postingMaterial: prepared.postingMaterial,
      postingSources: prepared.postingSources,
      requirements: Array.from({ length: 30 }, (_, index) => ({
        id: `requirement-${index}`,
        text: 'Engineering leadership',
      })),
    });
    expect(full.candidateSources).toHaveLength(150);
    expect(full.requirements).toHaveLength(30);
    expect(full.sourceCatalog).toHaveLength(151);
    const preflight = preflightOpportunityAssessmentRequest(full);
    expect(preflight.offeredSupportPredicates).toBeGreaterThan(0);
    expect(preflight.offeredSupportPredicates).toBe(
      full.citationScopes.reduce(
        (total, scope) => total + scope.candidateKeys.length,
        0,
      ),
    );
    expect(full.citationScopes.every((scope) => !scope.complete)).toBe(true);
    expect(preflight.offeredContradictionPredicates).toBe(0);
    for (const scope of full.citationScopes) {
      // A fitting request must retain useful evidence offers for every role
      // requirement, rather than spending the budget on empty predicates.
      expect(scope.candidateKeys.length).toBeGreaterThan(0);
      const offered = scope.candidateKeys.map((key) =>
        full.sourceCatalog.find((source) => source.key === key),
      );
      expect(offered.map((source) => source?.sourceId)).toEqual(
        expect.arrayContaining([
          'private-original-identifier-148',
          'private-original-identifier-149',
          'private-original-identifier-0',
          'private-original-identifier-1',
        ]),
      );
      const kinds = scope.candidateKeys.map(
        (key) => full.sourceCatalog.find((source) => source.key === key)?.kind,
      );
      expect(kinds).toEqual(
        expect.arrayContaining(['candidate_profile', 'achievement']),
      );
    }
    expect(preflightOpportunityAssessmentRequest(full)).toMatchObject({
      fits: true,
    });
    expect(full.coverage).toEqual({
      candidateTruncated: false,
      postingTruncated: false,
      requirementsTruncated: false,
    });
  });
  it('declines a fitting request with no offered support scope before billing', async () => {
    const noScope = prepareOpportunityAssessment({
      candidate: prepared.candidate,
      candidateMaterialFingerprint: 'unrelated-skills',
      candidateSources: [
        { id: 'skill', kind: 'skill', title: 'Unrelated', text: 'Unrelated' },
      ],
      postingMaterial: prepared.postingMaterial,
      postingSources: prepared.postingSources,
      requirements: [{ id: 'r', text: 'Platform work' }],
    });
    expect(preflightOpportunityAssessmentRequest(noScope)).toMatchObject({
      fits: false,
      reason: 'citation_scope',
      offeredSupportPredicates: 0,
    });
    await expect(
      evaluateOpportunityAssessment(noScope, {
        agentRunId: 'run',
        contentFingerprint: 'posting',
        opportunityId: 'opportunity',
        subjectFingerprint: 'subject',
        workspaceSubject,
      }),
    ).rejects.toThrow('No candidate citation scope');
    expect(mocks.execute).not.toHaveBeenCalled();
    expect(mocks.getAI).not.toHaveBeenCalled();
  });
});
