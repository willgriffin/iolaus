import { beforeEach, describe, expect, it, vi } from 'vitest';
import { extractMatchingSource } from './matching-source-extraction.js';

const mocks = vi.hoisted(() => ({
  chat: vi.fn(),
  reserve: vi.fn(),
  window: vi.fn(),
}));
vi.mock('./ai-config.js', () => ({
  resolveOpportunityIntelligenceExtractionAiProfileClient: async () => ({
    model: 'openai/gpt-6-luna',
    aiClient: { chat: mocks.chat },
  }),
}));
vi.mock('./opportunity-analysis-enrichment.js', () => ({
  ANALYSIS_MODEL: 'openai/gpt-6-luna',
  ensureAnalysisBudgetWindow: mocks.window,
}));
vi.mock('./opportunity-posting-preparation.js', () => ({
  countOpportunityInputTokens: async () => 100,
}));
vi.mock('./opportunity-intelligence-governance.js', () => ({
  attachOpportunityIntelligenceInvocationMetadata: (error: unknown) => error,
  executeGovernedOpportunityIntelligenceRequest: mocks.reserve,
}));

const input = {
  opportunityId: 'public-job',
  sourceContentFingerprint: 'f'.repeat(64),
  sourceContentVersion: 2,
  title: 'Backend Engineer',
  description: 'No mandatory qualifications.',
  location: 'Remote (Canada)',
};
const providerOutput = {
  coverage: 'complete',
  role: null,
  geography: null,
  noRequirements: { field: 'description', quote: input.description },
  required: [],
  preferred: [],
  unresolved: [],
};

beforeEach(() => {
  vi.resetAllMocks();
  mocks.window.mockResolvedValue('budget-window');
  mocks.reserve.mockImplementation(async (request) => ({
    ...(await request.invoke('request-1')),
    requestId: 'request-1',
  }));
  mocks.chat.mockResolvedValue({
    content: JSON.stringify(providerOutput),
    usage: { promptTokens: 100, completionTokens: 40 },
  });
});

describe('shared matching source provider', () => {
  it('passes only posting text to a governed reservation that hashes exact input', async () => {
    // An object with extra properties can arrive from another internal caller.
    // The outbound message must still be constructed from the public fields.
    const withExtraField = { ...input, privateCandidate: 'do not send' };
    await expect(
      extractMatchingSource(withExtraField, { budgetMicros: 50_000 }),
    ).resolves.toMatchObject({
      requestId: 'request-1',
      extraction: { coverage: 'complete' },
    });
    expect(mocks.window).toHaveBeenCalledWith(50_000, undefined);
    const first = mocks.reserve.mock.calls[0]?.[0];
    expect(first).toMatchObject({
      identity: {
        agentRunId: 'budget-window',
        opportunityId: input.opportunityId,
        contentFingerprint: input.sourceContentFingerprint,
        feature: 'opportunity-analysis',
      },
      inputTokenCeiling: 100,
    });
    const providerFormat = mocks.chat.mock.calls[0]?.[1]?.responseFormat;
    expect(providerFormat).toMatchObject({
      type: 'json_schema',
      json_schema: {
        strict: true,
        schema: {
          type: 'object',
          additionalProperties: false,
          required: expect.arrayContaining([
            'roleTitle',
            'workplaceType',
            'required',
            'unresolved',
            'nonRequirements',
          ]),
        },
      },
    });
    expect(first.workspaceSubject).toBeUndefined();
    expect(JSON.parse(mocks.chat.mock.calls[0]?.[0][1].content)).toEqual({
      title: input.title,
      description: input.description,
      location: input.location,
    });
    await extractMatchingSource(
      { ...input, description: ` ${input.description}` },
      { budgetMicros: 50_000 },
    );
    expect(mocks.reserve.mock.calls[1]?.[0].identity.inputFingerprint).not.toBe(
      first.identity.inputFingerprint,
    );
  });

  it('rejects responses without accounting or complete provider output', async () => {
    mocks.chat.mockResolvedValueOnce({
      content: JSON.stringify(providerOutput),
    });
    await expect(
      extractMatchingSource(input, { budgetMicros: 50_000 }),
    ).rejects.toThrow(/accounting/);
    mocks.chat.mockResolvedValueOnce({
      finishReason: 'length',
      content: JSON.stringify(providerOutput),
    });
    await expect(
      extractMatchingSource(input, { budgetMicros: 50_000 }),
    ).rejects.toThrow(/incomplete/);
  });
  it('classifies non-JSON output without exposing provider text', async () => {
    mocks.chat.mockResolvedValueOnce({
      content: 'raw provider diagnostic content',
      usage: { promptTokens: 100, completionTokens: 40 },
    });
    await expect(
      extractMatchingSource(input, { budgetMicros: 50_000 }),
    ).rejects.toMatchObject({
      code: 'matching_extraction_invalid_json',
      message: 'Matching extraction returned invalid JSON.',
    });
  });
});
