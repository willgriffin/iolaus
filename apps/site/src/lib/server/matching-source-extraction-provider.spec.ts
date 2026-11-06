import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { extractMatchingSource } from './matching-source-extraction.js';
import { matchingSourceSemanticMaterial } from './matching-source-semantics.js';

const mocks = vi.hoisted(() => ({
  chat: vi.fn(),
  resolveProfile: vi.fn(),
  reserve: vi.fn(),
  window: vi.fn(),
  tokenCount: vi.fn(),
  accounting: vi.fn((error: unknown, _metadata: unknown) => error),
}));
vi.mock('./ai-config.js', () => ({
  resolveOpportunityIntelligenceExtractionAiProfileClient: mocks.resolveProfile,
}));
vi.mock('./opportunity-analysis-enrichment.js', () => ({
  ANALYSIS_MODEL: 'openai/gpt-6-luna',
  ensureAnalysisBudgetWindow: mocks.window,
}));
vi.mock('./opportunity-posting-preparation.js', () => ({
  countOpportunityInputTokens: mocks.tokenCount,
}));
vi.mock('./opportunity-intelligence-governance.js', () => ({
  attachOpportunityIntelligenceInvocationMetadata: mocks.accounting,
  executeGovernedOpportunityIntelligenceRequest: mocks.reserve,
  OpportunityIntelligenceGovernanceError: class extends Error {
    constructor(
      readonly code: string,
      message: string,
    ) {
      super(message);
    }
  },
}));

const input = {
  opportunityId: 'public-job',
  sourceContentFingerprint: 'f'.repeat(64),
  sourceContentVersion: 2,
  title: 'Backend Engineer',
  description: 'No mandatory qualifications.',
  location: 'Remote (Canada)',
};
const options = { budgetMicros: 50_000 };
const usage = { promptTokens: 100, completionTokens: 40 };
const completion = (value: unknown) => ({
  content: JSON.stringify(value),
  usage,
});
const material = () =>
  matchingSourceSemanticMaterial({
    title: input.title,
    description: input.description,
    location: input.location,
  });
const draft = () => ({
  role: null,
  geography: null,
  ledger: material().units.map(({ id }) => ({
    id,
    kind: 'context',
    groups: [],
  })),
});
const verifierReply = (proposalDigest: string) => ({
  proposalDigest,
  sourceDigest: material().sourceDigest,
  roleCorrect: true,
  geographyCorrect: true,
  units: material().units.map(({ id }) => ({
    id,
    classificationCorrect: true,
    allConditionsRepresented: true,
    logicAndQualifiersPreserved: true,
  })),
});

beforeEach(() => {
  vi.resetAllMocks();
  mocks.resolveProfile.mockImplementation(async ({ maxOutputTokens }) => ({
    model: 'openai/gpt-6-luna',
    aiClient: {
      chat: (messages: unknown, options: { maxTokens: number }) => {
        if (options.maxTokens > (maxOutputTokens ?? 4096))
          throw new Error(
            'Requested output exceeds the configured profile ceiling.',
          );
        return mocks.chat(messages, options);
      },
    },
  }));
  mocks.window.mockResolvedValue('budget-window');
  mocks.tokenCount.mockResolvedValue(100);
  mocks.accounting.mockImplementation((error: unknown) => error);
  let count = 0;
  mocks.reserve.mockImplementation(async (request) => {
    const requestId = `request-${++count}`;
    return { ...(await request.invoke(requestId)), requestId };
  });
  mocks.chat.mockImplementation(async (messages) => {
    const payload = JSON.parse(messages[1].content);
    return completion(
      payload.proposalDigest ? verifierReply(payload.proposalDigest) : draft(),
    );
  });
});

afterEach(() => vi.restoreAllMocks());

describe('shared matching source provider', () => {
  it('accounts for two distinct requests in one window using only public source material', async () => {
    // Extra fields can arrive from an internal caller. The outbound body
    // must be built from the public source fields even in this case.
    const withExtraField = { ...input, privateCandidate: 'do not send' };
    await expect(
      extractMatchingSource(withExtraField, options),
    ).resolves.toMatchObject({
      requestId: 'request-2',
      extraction: { coverage: 'partial', semantic: expect.any(Object) },
    });
    expect(mocks.window).toHaveBeenCalledExactlyOnceWith(
      50_000,
      expect.stringMatching(/^\d{4}-\d{2}-\d{2}T\d{2}$/u),
    );
    expect(mocks.resolveProfile).toHaveBeenCalledExactlyOnceWith({
      maxOutputTokens: 9_000,
    });
    expect(mocks.reserve).toHaveBeenCalledTimes(2);
    const [first, second] = mocks.reserve.mock.calls.map(
      ([request]) => request,
    );
    for (const request of [first, second]) {
      expect(request).toMatchObject({
        identity: {
          agentRunId: 'budget-window',
          opportunityId: input.opportunityId,
          contentFingerprint: input.sourceContentFingerprint,
          feature: 'opportunity-analysis',
          model: 'openai/gpt-6-luna',
        },
        inputTokenCeiling: 100,
      });
      expect(request.workspaceSubject).toBeUndefined();
    }
    expect(first.identity.inputFingerprint).not.toBe(
      second.identity.inputFingerprint,
    );
    expect(first.identity.promptVersion).toMatch(/\/draft$/);
    expect(second.identity.promptVersion).toMatch(/\/verification$/);
    const [firstChat, secondChat] = mocks.chat.mock.calls;
    for (const [messages, settings] of [firstChat, secondChat]) {
      expect(JSON.stringify(messages)).not.toContain('do not send');
      expect(settings.timeout).toBeLessThanOrEqual(60_000);
      expect(settings.responseFormat).toMatchObject({
        type: 'json_schema',
        json_schema: { strict: true },
      });
    }
    const unitCount = material().units.length;
    expect(
      firstChat[1].responseFormat.json_schema.schema.properties.ledger,
    ).toMatchObject({
      minItems: unitCount,
      maxItems: unitCount,
      items: {
        anyOf: [
          {
            properties: {
              kind: { enum: ['context', 'unresolved'] },
              groups: { maxItems: 0, items: { type: 'string' } },
            },
          },
          {
            properties: {
              kind: { enum: ['requirement', 'preferred'] },
              id: { enum: ['d1'] },
            },
          },
        ],
      },
    });
    expect(
      secondChat[1].responseFormat.json_schema.schema.properties.units,
    ).toMatchObject({
      minItems: unitCount,
      maxItems: unitCount,
    });
    expect(JSON.parse(firstChat[0][1].content)).toEqual(material());
    expect(JSON.parse(secondChat[0][1].content)).toEqual({
      ...material(),
      proposal: draft(),
      proposalDigest: expect.stringMatching(/^[0-9a-f]{64}$/),
    });
  });

  it('does not reserve the verifier against an elapsed UTC window', async () => {
    const time = vi
      .spyOn(Date, 'now')
      .mockReturnValue(Date.UTC(2026, 10, 4, 21, 59, 59));
    mocks.chat.mockImplementationOnce(async () => {
      time.mockReturnValue(Date.UTC(2026, 10, 4, 22));
      return completion(draft());
    });
    await expect(extractMatchingSource(input, options)).rejects.toMatchObject({
      code: 'budget_exhausted',
    });
    expect(mocks.reserve).toHaveBeenCalledTimes(1);
  });

  it('leaves the draft unpublished when the verifier cannot reserve capacity', async () => {
    mocks.reserve
      .mockImplementationOnce(async (request) => ({
        ...(await request.invoke('draft-request')),
        requestId: 'draft-request',
      }))
      .mockRejectedValueOnce(new Error('ledger budget exhausted'));
    await expect(extractMatchingSource(input, options)).rejects.toThrow(
      'ledger budget exhausted',
    );
    expect(mocks.chat).toHaveBeenCalledTimes(1);
  });

  it('reuses a completed draft across an hourly admission refusal', async () => {
    const cache = new Map<string, { output: unknown; requestId: string }>();
    let blockedVerification = false;
    mocks.window
      .mockResolvedValueOnce('first-hour')
      .mockResolvedValueOnce('second-hour');
    mocks.reserve.mockImplementation(async (request) => {
      const { inputFingerprint, promptVersion } = request.identity;
      const cached = cache.get(inputFingerprint);
      if (cached) return { ...cached, reused: true };
      if (promptVersion.endsWith('/verification') && !blockedVerification) {
        blockedVerification = true;
        throw new Error('ledger budget exhausted');
      }
      const requestId = `request-${cache.size + 1}`;
      const { output } = await request.invoke(requestId);
      cache.set(inputFingerprint, { output, requestId });
      return { output, requestId, reused: false };
    });

    await expect(extractMatchingSource(input, options)).rejects.toThrow(
      'ledger budget exhausted',
    );
    await expect(extractMatchingSource(input, options)).resolves.toMatchObject({
      requestId: 'request-2',
    });
    expect(mocks.reserve).toHaveBeenCalledTimes(4);
    expect(mocks.chat).toHaveBeenCalledTimes(2);
    expect(mocks.reserve.mock.calls[2]?.[0].identity).toMatchObject({
      agentRunId: 'second-hour',
      inputFingerprint:
        mocks.reserve.mock.calls[0]?.[0].identity.inputFingerprint,
    });
  });

  it('rejects a verdict bound to another proposal and accounts for its usage', async () => {
    mocks.chat
      .mockResolvedValueOnce(completion(draft()))
      .mockResolvedValueOnce(completion(verifierReply('a'.repeat(64))));
    await expect(extractMatchingSource(input, options)).rejects.toMatchObject({
      name: 'MatchingSourceExtractionError',
    });
    expect(mocks.accounting).toHaveBeenCalledWith(expect.any(Error), {
      usage,
      providerRequestId: 'request-2',
    });
  });

  it('rejects a verifier request that exceeds the token ceiling before reserving it', async () => {
    mocks.tokenCount.mockResolvedValueOnce(100).mockResolvedValueOnce(16_001);
    await expect(extractMatchingSource(input, options)).rejects.toThrow(
      /token ceiling/,
    );
    expect(mocks.reserve).toHaveBeenCalledTimes(1);
    expect(mocks.chat).toHaveBeenCalledTimes(1);
  });

  it('rejects responses without accounting or complete provider output', async () => {
    mocks.chat.mockResolvedValueOnce({
      content: JSON.stringify(draft()),
    });
    await expect(extractMatchingSource(input, options)).rejects.toThrow(
      /accounting/,
    );
    mocks.chat.mockResolvedValueOnce({
      finishReason: 'length',
      content: JSON.stringify(draft()),
    });
    await expect(extractMatchingSource(input, options)).rejects.toThrow(
      /incomplete/,
    );
  });

  it('classifies non-JSON output without exposing provider text', async () => {
    mocks.chat.mockResolvedValueOnce({
      content: 'raw provider diagnostic content',
      usage,
    });
    await expect(extractMatchingSource(input, options)).rejects.toMatchObject({
      code: 'matching_extraction_invalid_json',
      message: 'Matching extraction returned invalid JSON.',
    });
  });
});
