import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { evaluateSkillMatches } from './skill-decision-provider.js';
import { prepareSkillMatching } from './skill-matching.js';

const mocks = vi.hoisted(() => ({
  getAI: vi.fn(),
  execute: vi.fn(),
  decide: vi.fn(),
  capabilities: vi.fn(),
}));
vi.mock('@happyvertical/ai', () => ({ getAI: mocks.getAI }));
vi.mock('./opportunity-intelligence-governance.js', () => ({
  executeGovernedOpportunityIntelligenceRequest: mocks.execute,
}));
const prepared = prepareSkillMatching(
  ['backend JavaScript'],
  [{ id: 's1', kind: 'resume_skill', title: 'Node.js', text: 'Node.js' }],
);
const options = {
  agentRunId: 'run-1',
  opportunityId: 'opp-1',
  contentFingerprint: 'content-1',
};
describe('skill decision provider', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.stubEnv('OPPORTUNITY_SKILL_DECISIONS_ENABLED', 'true');
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
      getCapabilities: mocks.capabilities,
      decide: mocks.decide,
    });
    mocks.capabilities.mockResolvedValue({ decisions: true });
    mocks.execute.mockImplementation(async (options) => options.invoke());
    mocks.decide.mockResolvedValue({
      model: 'jev-test',
      provenance: { provider: 'typesafe', model: 'jev-test' },
      usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
      answers: {
        match_0: { type: 'predicate', probability: 0.99 },
        source_0: {
          type: 'choice',
          choice: 'candidate_0',
          confidence: 0.99,
          probabilities: { candidate_0: 0.99, none: 0.005, uncertain: 0.005 },
        },
      },
    });
  });
  afterEach(() => vi.unstubAllEnvs());
  it('leaves the existing route available when disabled', async () => {
    vi.stubEnv('OPPORTUNITY_SKILL_DECISIONS_ENABLED', 'false');
    expect(await evaluateSkillMatches(prepared, options)).toBeUndefined();
    expect(mocks.getAI).not.toHaveBeenCalled();
  });
  it('uses dedicated credentials/pricing and forwards cancellation under governance', async () => {
    const signal = new AbortController().signal;
    expect(
      (await evaluateSkillMatches(prepared, { ...options, signal }))?.matches[0]
        .status,
    ).toBe('supported');
    expect(mocks.execute).toHaveBeenCalledWith(
      expect.objectContaining({
        signal,
        identity: expect.objectContaining({
          feature: 'opportunity-skill-match',
          inputFingerprint: prepared.fingerprint,
        }),
        config: expect.objectContaining({
          pricing: {
            configured: true,
            inputMicrosPerMillion: 1000,
            outputMicrosPerMillion: 2000,
          },
        }),
      }),
    );
    expect(mocks.decide).toHaveBeenCalledWith(
      prepared.request,
      expect.objectContaining({ signal, timeout: 30000 }),
    );
  });
  it.each([
    'TYPESAFE_API_KEY',
    'OPPORTUNITY_SKILL_DECISION_INPUT_COST_MICROS_PER_MILLION',
  ])('fails explicitly without %s', async (name) => {
    vi.stubEnv(name, '');
    await expect(evaluateSkillMatches(prepared, options)).rejects.toThrow();
    expect(mocks.decide).not.toHaveBeenCalled();
  });
  it('requires a reservation owner', async () => {
    await expect(
      evaluateSkillMatches(prepared, { ...options, agentRunId: undefined }),
    ).rejects.toThrow('AgentRun');
  });
  it('fails when the provider does not advertise decisions', async () => {
    mocks.capabilities.mockResolvedValue({});
    await expect(evaluateSkillMatches(prepared, options)).rejects.toThrow(
      'does not support',
    );
  });
  it('propagates provider failure rather than manufacturing a negative match', async () => {
    mocks.decide.mockRejectedValue(new Error('timeout'));
    await expect(evaluateSkillMatches(prepared, options)).rejects.toThrow(
      'timeout',
    );
  });
});
