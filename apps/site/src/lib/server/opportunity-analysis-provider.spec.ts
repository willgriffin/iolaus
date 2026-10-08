import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { OpportunityAnalysisSnapshot } from '$lib/opportunity-analysis-contract.js';

const state = vi.hoisted(() => ({
  chat: vi.fn(),
  query: vi.fn(),
  governed: vi.fn(),
  profile: vi.fn(),
}));
vi.mock('@happyvertical/smrt-core', async (original) => ({
  ...(await original<object>()),
  resolveDatabase: async () => ({ query: state.query }),
}));
vi.mock('./smrt.js', () => ({ getCollection: vi.fn() }));
vi.mock('./db.js', () => ({
  getDbConfig: () => ({ type: 'sqlite', url: ':memory:' }),
}));
vi.mock('./ai-config.js', () => ({
  resolveOpportunityIntelligenceExtractionAiProfileClient: state.profile,
}));
vi.mock('./opportunity-intelligence-governance.js', async (original) => ({
  ...(await original<object>()),
  executeGovernedOpportunityIntelligenceRequest: state.governed,
  attachOpportunityIntelligenceInvocationMetadata: (error: unknown) => error,
}));

import {
  ANALYSIS_MODEL,
  enrichOpportunityAnalysis,
} from './opportunity-analysis-enrichment.js';
import { OpportunityIntelligenceGovernanceError } from './opportunity-intelligence-governance.js';

const snapshot: OpportunityAnalysisSnapshot = {
  id: 'a',
  opportunityId: 'o',
  sourceContentFingerprint: 'a'.repeat(64),
  sourceContentVersion: 1,
  analysisVersion: 'opportunity-analysis/v1',
  status: 'deterministic',
  normalizedTitle: 'Engineer',
  seniority: 'unknown',
  function: 'unknown',
  workMode: 'unknown',
  employmentType: 'unknown',
  skills: [],
  requirements: [],
  skillSlugs: [],
  summaryBullets: [],
  eligibility: {
    remote: null,
    countries: [],
    regions: [],
    timezones: [],
    flags: 0,
    workAuthorization: { required: [], sponsorship: 'unknown' },
  },
  compensation: null,
};
const input = {
  opportunityId: 'o',
  sourceContentFingerprint: 'a'.repeat(64),
  sourceContentVersion: 1,
  title: 'Engineer',
  description: 'Python required.',
  deterministic: snapshot,
};
const output = {
  summaryBullets: ['Python required.'],
  skills: [],
  requirements: [],
};
beforeEach(() => {
  vi.stubEnv('OPPORTUNITY_INTELLIGENCE_ENABLED', 'true');
  vi.stubEnv('OPPORTUNITY_INTELLIGENCE_RUN_CALL_LIMIT', '8');
  vi.stubEnv('OPPORTUNITY_INTELLIGENCE_RUN_INPUT_TOKEN_LIMIT', '100000');
  vi.stubEnv('OPPORTUNITY_INTELLIGENCE_RUN_SPEND_LIMIT_MICROS', '50000');
  vi.clearAllMocks();
  state.query.mockResolvedValue({ rows: [] });
  state.profile.mockResolvedValue({
    model: ANALYSIS_MODEL,
    aiClient: { chat: state.chat },
    timeout: 10_000,
  });
  state.chat.mockResolvedValue({
    content: JSON.stringify(output),
    usage: { promptTokens: 100, completionTokens: 20, totalTokens: 120 },
    finishReason: 'stop',
  });
  state.governed.mockImplementation(
    async (options: {
      invoke: (id: string) => Promise<{ output: unknown }>;
    }) => ({
      output: (await options.invoke('request-1')).output,
      requestId: 'request-1',
      reused: false,
    }),
  );
});
afterEach(() => vi.unstubAllEnvs());
describe('production analysis provider protocol', () => {
  it('uses pinned profile, real usage, global identity and source-only prompt', async () => {
    const result = await enrichOpportunityAnalysis(
      { ...input, privateCandidate: 'must-not-send' } as typeof input,
      { budgetMicros: 1000 },
    );
    expect(result).toMatchObject({
      requestId: 'request-1',
      model: ANALYSIS_MODEL,
      inputTokens: 100,
      outputTokens: 20,
      costMicros: 20,
      snapshot: { status: 'enriched' },
    });
    const request = state.governed.mock.calls[0][0];
    expect(request.identity).toMatchObject({
      feature: 'opportunity-analysis',
      model: ANALYSIS_MODEL,
    });
    expect(request.workspaceSubject).toBeUndefined();
    expect(request.billedUser).toBeUndefined();
    expect(request.identity.sourceCrawlId).toBeUndefined();
    expect(JSON.stringify(state.chat.mock.calls)).not.toContain(
      'must-not-send',
    );
    expect(state.chat.mock.calls[0][1]).toMatchObject({
      model: ANALYSIS_MODEL,
      responseFormat: { type: 'json_object' },
      user: 'request-1',
    });
    expect(request.identity.agentRunId).toMatch(
      /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-8[a-f0-9]{3}-[a-f0-9]{12}$/,
    );
  });
  it('changes input identity for exact source whitespace without changing version', async () => {
    await enrichOpportunityAnalysis(input, { budgetMicros: 1000 });
    await enrichOpportunityAnalysis(
      { ...input, description: 'Python required. ' },
      { budgetMicros: 1000 },
    );
    expect(state.governed.mock.calls[0][0].identity.inputFingerprint).not.toBe(
      state.governed.mock.calls[1][0].identity.inputFingerprint,
    );
  });
  it('rejects missing usage and invalid output with bounded accounted attempts', async () => {
    state.chat.mockResolvedValue({ content: JSON.stringify(output) });
    await expect(
      enrichOpportunityAnalysis(input, { budgetMicros: 1000 }),
    ).rejects.toThrow('usage');
    expect(state.governed).toHaveBeenCalledTimes(3);
    expect(state.chat).toHaveBeenCalledTimes(3);
  });
  it('does not retry circuit or budget refusal, or change provider when pinned profile absent', async () => {
    state.governed.mockRejectedValue(
      new OpportunityIntelligenceGovernanceError('budget_exhausted', 'refused'),
    );
    await expect(
      enrichOpportunityAnalysis(input, { budgetMicros: 1000 }),
    ).rejects.toThrow('refused');
    expect(state.governed).toHaveBeenCalledTimes(1);
    expect(state.chat).not.toHaveBeenCalled();
    state.profile.mockResolvedValue(null);
    await expect(
      enrichOpportunityAnalysis(input, { budgetMicros: 1000 }),
    ).rejects.toThrow('Pinned');
  });
  it('refuses arbitrary windows and zero budgets without calling provider', async () => {
    await expect(
      enrichOpportunityAnalysis(input, { budgetMicros: 0 }),
    ).rejects.toThrow();
    await expect(
      enrichOpportunityAnalysis(input, {
        budgetMicros: 1000,
        windowId: 'extra-window',
      }),
    ).rejects.toThrow();
    expect(state.chat).not.toHaveBeenCalled();
  });
});
