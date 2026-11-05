import type { AIResponse } from '@happyvertical/ai';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AiUsageRefusedError } from './ai-usage-guard.js';
import { candidateInterpretationConcepts } from './matching-candidate-contract.js';
import {
  chunkMatchingCandidateEvidence,
  estimateMatchingCandidateInterpretation,
  interpretMatchingCandidateChunk,
  matchingCandidateDraftRequestId,
  matchingCandidateVerificationRequestId,
  verifyMatchingCandidateChunk,
} from './matching-candidate-interpretation.js';
import { compileMatchingVocabulary } from './normalized-matching.js';
import { SKILL_VOCABULARY_SEED_TERMS } from './skill-vocabulary.js';

const mocks = vi.hoisted(() => ({
  assertEnabled: vi.fn(),
  chat: vi.fn(),
  currentSubject: vi.fn(),
  fence: vi.fn(),
  profile: vi.fn(),
  release: vi.fn(),
  reserve: vi.fn(),
  settle: vi.fn(),
}));

vi.mock('./ai-config.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./ai-config.js')>()),
  resolveMatchingCandidateAiProfileClient: mocks.profile,
}));
vi.mock('./ai-usage-guard.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./ai-usage-guard.js')>()),
  assertAiEnabled: mocks.assertEnabled,
  reserveAiUserSpend: mocks.reserve,
}));
vi.mock('./workspace-subject.js', () => ({
  requireCurrentCandidateWorkspaceSubject: mocks.currentSubject,
}));

const subject = {
  profileId: 'candidate-private',
  tenantId: 'tenant-private',
  userId: 'owner-private',
};
const text =
  'Optimized PostgreSQL queries for a live service handling paying customers.';
const source = {
  id: 'position:raw-private-id',
  text,
  kind: 'fact',
} as const;
const vocabulary = compileMatchingVocabulary(SKILL_VOCABULARY_SEED_TERMS);
const input = { evidence: [source] };
const options = {
  subject,
  input,
  vocabulary,
  requestId: 'opaque-chunk-0001',
  revalidate: mocks.fence,
};
const usage = {
  promptTokens: 2_000,
  completionTokens: 100,
  totalTokens: 2_100,
};
const wire = {
  assertions: [
    {
      sourceId: 'source-1',
      conceptId: 'postgresql',
      quote: text,
      activityQuote: null,
      support: 'action' as const,
      context: 'production' as const,
      polarity: 'positive' as const,
      period: null,
      duration: null,
    },
  ],
  reviewedSourceIds: ['source-1'],
  unresolvedSourceIds: [],
};

const concepts = candidateInterpretationConcepts(vocabulary);

function draftConceptId(conceptId: string): string {
  const index = concepts.findIndex(
    (concept) => concept.conceptId === conceptId,
  );
  return index < 0 ? conceptId : `c${index + 1}`;
}

function serializeDraft<
  T extends {
    sourceId: string;
    activityQuote: string | null;
    conceptId: string;
  },
>({
  assertions,
  ...coverage
}: {
  assertions: readonly T[];
  reviewedSourceIds: readonly string[];
  unresolvedSourceIds: readonly string[];
}): string {
  const activities = new Map<
    string,
    {
      sourceId: string;
      activityQuote: string | null;
      assertions: { conceptId: string }[];
    }
  >();
  for (const { sourceId, activityQuote, ...claim } of assertions) {
    const key = JSON.stringify([sourceId, activityQuote]);
    const group = activities.get(key) ?? {
      sourceId,
      activityQuote,
      assertions: [],
    };
    group.assertions.push({
      ...claim,
      conceptId: draftConceptId(claim.conceptId),
    });
    activities.set(key, group);
  }
  return JSON.stringify({
    ...coverage,
    activities: [...activities.values()],
  });
}

describe('private candidate interpretation provider', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.currentSubject.mockReturnValue(subject);
    mocks.profile.mockImplementation(async (_maxOutputTokens, model) => ({
      aiClient: { chat: mocks.chat },
      model,
      timeout: 100_000,
    }));
    mocks.reserve.mockResolvedValue({
      settle: mocks.settle,
      release: mocks.release,
    });
    mocks.chat.mockResolvedValue({ content: serializeDraft(wire), usage });
  });

  it('uses the stronger draft for narrative chunks and accounts for that choice in preflight', async () => {
    const narrative = {
      evidence: [{ ...source, kind: 'experience' as const }],
    };
    const estimated = estimateMatchingCandidateInterpretation(
      narrative,
      vocabulary,
    );
    expect(estimated.reservedSpendMicros).toBeGreaterThan(
      estimateMatchingCandidateInterpretation(input, vocabulary)
        .reservedSpendMicros,
    );
    const narrativeOptions = { ...options, input: narrative };
    const predictedRequestId =
      matchingCandidateDraftRequestId(narrativeOptions);
    expect(predictedRequestId).not.toBe(
      matchingCandidateDraftRequestId(options),
    );
    expect(mocks.profile).not.toHaveBeenCalled();
    const result = await interpretMatchingCandidateChunk(narrativeOptions);
    const [messages, config] = mocks.chat.mock.calls[0];
    expect(messages[0].content).toContain(
      'use the stronger production context',
    );
    expect(config.model).toBe('openai/gpt-6.1-sol');
    expect(config.user).toBe(predictedRequestId);
    expect(result.requestId).toBe(predictedRequestId);
    expect(mocks.settle).toHaveBeenCalledWith(5_000, 'actual');
  });

  it('plans every source in stable bounded chunks, including the full seeded vocabulary', () => {
    const evidence = Array.from({ length: 50 }, (_, index) => ({
      ...source,
      id: `position:${index}`,
    }));
    const chunks = chunkMatchingCandidateEvidence({ evidence }, vocabulary);
    expect(chunks).toHaveLength(3);
    expect(chunks.flatMap((chunk) => chunk.evidence)).toEqual(evidence);
    expect(chunkMatchingCandidateEvidence({ evidence }, vocabulary)).toEqual(
      chunks,
    );
    expect(
      estimateMatchingCandidateInterpretation({ evidence }, vocabulary),
    ).toEqual({
      chunks: 3,
      requests: 6,
      sources: 50,
      estimatedInputTokens: expect.any(Number),
      reservedSpendMicros: expect.any(Number),
    });
    expect(mocks.profile).not.toHaveBeenCalled();
    expect(mocks.reserve).not.toHaveBeenCalled();
  });

  it('rejects an unfit full capture before any provider work', async () => {
    const unfit = {
      evidence: [
        source,
        { ...source, id: 'oversize', text: 'a'.repeat(30_000) },
      ],
    };
    expect(() => chunkMatchingCandidateEvidence(unfit, vocabulary)).toThrow(
      'candidate_interpretation_input_limit',
    );
    await expect(
      interpretMatchingCandidateChunk({ ...options, input: unfit }),
    ).rejects.toMatchObject({
      code: 'candidate_interpretation_input_limit',
    });
    expect(mocks.profile).not.toHaveBeenCalled();
    expect(mocks.reserve).not.toHaveBeenCalled();
  });

  it('uses the verified owner, scoped private purpose and a request fence, with actual usage settlement', async () => {
    const result = await interpretMatchingCandidateChunk({
      ...options,
      input: {
        ...input,
        questions: [
          { id: 'private-question', text: 'screening prompt', required: true },
        ],
      },
    } as typeof options);
    const { requestId } = result;
    expect(requestId).toMatch(/^[a-f0-9]{64}$/u);
    expect(requestId).toBe(matchingCandidateDraftRequestId(options));
    expect(mocks.reserve).toHaveBeenCalledWith(
      expect.objectContaining({
        subject,
        feature: 'matching-candidate-interpretation',
        requireBudgetLimit: true,
        requestId,
      }),
    );
    const [messages, chatOptions] = mocks.chat.mock.calls[0];
    const serialized = JSON.stringify(messages);
    expect(serialized).toContain(text);
    expect(JSON.parse(messages[1].content).concepts).toContainEqual([
      draftConceptId('postgresql'),
      'PostgreSQL',
    ]);
    for (const privateIdentifier of [
      source.id,
      subject.profileId,
      subject.tenantId,
      subject.userId,
      'screening prompt',
    ])
      expect(serialized).not.toContain(privateIdentifier);
    expect(chatOptions).toMatchObject({
      model: 'openai/gpt-6-luna',
      maxTokens: 4_096,
      continueOnLength: false,
      reasoning: { maxTokens: 1_024 },
      timeout: 60_000,
      user: requestId,
      responseFormat: {
        type: 'json_schema',
        json_schema: {
          strict: true,
          schema: {
            properties: {
              activities: {
                maxItems: 64,
                items: {
                  required: expect.arrayContaining(['activityQuote']),
                  properties: {
                    sourceId: { enum: ['source-1'] },
                    assertions: {
                      minItems: 1,
                      maxItems: 64,
                      items: {
                        properties: {
                          conceptId: {
                            enum: expect.arrayContaining([
                              draftConceptId('postgresql'),
                            ]),
                          },
                        },
                      },
                    },
                  },
                },
              },
              reviewedSourceIds: { items: { enum: ['source-1'] } },
              unresolvedSourceIds: { items: { enum: ['source-1'] } },
            },
          },
        },
      },
    });
    expect(mocks.reserve.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.fence.mock.invocationCallOrder[0],
    );
    expect(mocks.fence.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.chat.mock.invocationCallOrder[0],
    );
    expect(mocks.settle).toHaveBeenCalledWith(250, 'actual');
    expect(result.interpretation).toEqual({
      ...wire,
      assertions: [{ ...wire.assertions[0], sourceId: source.id }],
      reviewedSourceIds: [source.id],
    });
  });

  it('independently rejects a semantically unsupported claim with an exact source quote', async () => {
    const plausibleButUnsupported = {
      ...wire.assertions[0],
      conceptId: 'system-scalability',
    };
    mocks.chat.mockResolvedValueOnce({
      content: serializeDraft({
        ...wire,
        assertions: [...wire.assertions, plausibleButUnsupported],
      }),
      usage,
    });
    mocks.chat.mockResolvedValueOnce({
      content: JSON.stringify({
        decisions: [
          { index: 1, supported: false },
          { index: 0, supported: true },
        ],
        unresolvedSourceIds: [],
      }),
      usage,
    });
    const proposed = await interpretMatchingCandidateChunk(options);
    expect(proposed.interpretation.assertions).toHaveLength(2);
    const verified = await verifyMatchingCandidateChunk({
      ...options,
      draft: proposed.interpretation,
    });
    expect(verified.requestId).not.toBe(proposed.requestId);
    expect(verified.requestId).toBe(
      matchingCandidateVerificationRequestId(options),
    );
    expect(verified.interpretation).toEqual({
      assertions: [{ ...wire.assertions[0], sourceId: source.id }],
      reviewedSourceIds: [],
      unresolvedSourceIds: [source.id],
    });
    const [messages, chatOptions] = mocks.chat.mock.calls[1];
    expect(messages[0].content).toContain('Independently verify');
    expect(messages[1].content).toContain(text);
    expect(JSON.parse(messages[1].content).implications).toContainEqual([
      'backend-development',
      expect.arrayContaining(['software-development']),
    ]);
    expect(messages[1].content).toContain('nodejs');
    expect(messages[2].content).not.toContain('nodejs');
    expect(messages[2].content).toContain('system-scalability');
    expect(JSON.stringify(messages)).not.toContain(source.id);
    expect(chatOptions).toMatchObject({
      model: 'openai/gpt-6.1-sol',
      maxTokens: 2_048,
      responseFormat: {
        type: 'json_schema',
        json_schema: {
          strict: true,
          schema: {
            properties: {
              decisions: {
                minItems: 2,
                maxItems: 2,
                items: { properties: { index: { minimum: 0, maximum: 1 } } },
              },
              unresolvedSourceIds: { items: { enum: ['source-1'] } },
            },
          },
        },
      },
    });
    expect(mocks.fence).toHaveBeenCalledTimes(2);
    expect(mocks.settle.mock.calls).toEqual([
      [250, 'actual'],
      [5_000, 'actual'],
    ]);
    const reserved = mocks.reserve.mock.calls.reduce(
      (total, [reservation]) => total + reservation.micros,
      0,
    );
    expect(reserved).toBeLessThanOrEqual(
      estimateMatchingCandidateInterpretation(input, vocabulary)
        .reservedSpendMicros,
    );
  });

  it('verifies empty drafts and can flag omitted candidate evidence', async () => {
    const draft = {
      assertions: [],
      reviewedSourceIds: [source.id],
      unresolvedSourceIds: [],
    };
    mocks.chat.mockResolvedValue({
      content: JSON.stringify({
        decisions: [],
        unresolvedSourceIds: ['source-1'],
      }),
      usage,
    });
    const result = await verifyMatchingCandidateChunk({ ...options, draft });
    expect(mocks.chat.mock.calls[0][0][1].content).toContain('postgresql');
    expect(result.interpretation).toEqual({
      assertions: [],
      reviewedSourceIds: [],
      unresolvedSourceIds: [source.id],
    });
  });

  it('keeps a short exact positive action with unproven context scoped as unresolved', async () => {
    const capture = {
      ...source,
      text: 'The first service ran in production. I optimized queries. I have never optimized the other database.',
    };
    const request = { ...options, input: { evidence: [capture] } };
    const assertion = {
      ...wire.assertions[0],
      conceptId: 'database-performance-tuning',
      quote: 'optimized queries',
    };
    mocks.chat.mockResolvedValueOnce({
      content: serializeDraft({
        ...wire,
        assertions: [
          assertion,
          {
            ...assertion,
            quote: 'I have never optimized the other database.',
            support: 'stated',
            polarity: 'negative',
          },
        ],
      }),
      usage,
    });
    mocks.chat.mockResolvedValueOnce({
      content: JSON.stringify({
        decisions: [{ index: 0, supported: true }],
        unresolvedSourceIds: [],
      }),
      usage,
    });
    const { interpretation: draft } =
      await interpretMatchingCandidateChunk(request);
    expect(draft).toMatchObject({
      assertions: [
        { quote: 'optimized queries', context: null, polarity: 'positive' },
      ],
      reviewedSourceIds: [],
      unresolvedSourceIds: [capture.id],
    });
    const { interpretation } = await verifyMatchingCandidateChunk({
      ...request,
      draft,
    });
    expect(interpretation).toEqual(draft);
  });

  it('sends a shared exact activity anchor once and verifies each claim separately', async () => {
    const activityQuote =
      'For the Atlas service, I deployed application services. For that same Atlas service, I configured service health monitoring.';
    const capture = { ...source, text: activityQuote };
    const request = { ...options, input: { evidence: [capture] } };
    const deployed = {
      ...wire.assertions[0],
      conceptId: 'service-deployment',
      quote: 'I deployed application services',
      activityQuote,
      context: null,
    };
    const monitored = {
      ...deployed,
      conceptId: 'service-monitoring',
      quote: 'I configured service health monitoring',
    };
    mocks.chat.mockResolvedValueOnce({
      content: serializeDraft({ ...wire, assertions: [deployed, monitored] }),
      usage,
    });
    mocks.chat.mockResolvedValueOnce({
      content: JSON.stringify({
        decisions: [
          { index: 0, supported: true },
          { index: 1, supported: false },
        ],
        unresolvedSourceIds: [],
      }),
      usage,
    });
    const { interpretation: draft } =
      await interpretMatchingCandidateChunk(request);
    expect(draft.assertions).toHaveLength(2);
    const verified = await verifyMatchingCandidateChunk({ ...request, draft });
    expect(verified.interpretation).toEqual({
      assertions: [{ ...deployed, sourceId: capture.id }],
      reviewedSourceIds: [],
      unresolvedSourceIds: [capture.id],
    });
    const [messages] = mocks.chat.mock.calls[1];
    const material = JSON.parse(messages[2].content);
    expect(material.passages).toEqual([
      deployed.quote,
      activityQuote,
      monitored.quote,
    ]);
    expect(
      material.assertions.map((claim: unknown[]) => [claim[2], claim[7]]),
    ).toEqual([
      [0, 1],
      [2, 1],
    ]);
  });

  it('drops a negative assertion whose exact quote omits its production qualifier', async () => {
    const capture = {
      ...source,
      text: 'I have never used PostgreSQL in production.',
    };
    mocks.chat.mockResolvedValueOnce({
      content: serializeDraft({
        ...wire,
        assertions: [
          {
            ...wire.assertions[0],
            quote: 'I have never used PostgreSQL',
            context: null,
            support: 'stated',
            polarity: 'negative',
          },
        ],
      }),
      usage,
    });
    const { interpretation } = await interpretMatchingCandidateChunk({
      ...options,
      input: { evidence: [capture] },
    });
    expect(interpretation).toEqual({
      assertions: [],
      reviewedSourceIds: [],
      unresolvedSourceIds: [capture.id],
    });
  });

  it('compacts a rich multi-concept draft into the exact bounded verification envelope', async () => {
    const paragraph =
      'I led a production migration and designed the delivery and recovery process. ';
    const quote = paragraph.repeat(8).trim();
    const capture = { ...source, text: quote };
    const request = { ...options, input: { evidence: [capture] } };
    const assertions = concepts
      .filter(({ conceptId }) => !['nodejs', 'postgresql'].includes(conceptId))
      .slice(0, 20)
      .map(({ conceptId }) => ({
        ...wire.assertions[0],
        conceptId,
        quote,
        activityQuote: quote,
      }));
    const proposed = serializeDraft({ ...wire, assertions });
    expect(Buffer.byteLength(proposed)).toBeGreaterThan(8_192);
    const grouped = JSON.parse(proposed).activities;
    expect(grouped).toHaveLength(1);
    expect(grouped[0]).toMatchObject({
      sourceId: 'source-1',
      activityQuote: quote,
    });
    expect(grouped[0].assertions).toHaveLength(20);
    expect(grouped[0].assertions[0]).not.toHaveProperty('activityQuote');
    mocks.chat.mockResolvedValueOnce({ content: proposed, usage });
    mocks.chat.mockResolvedValueOnce({
      content: JSON.stringify({
        decisions: assertions.map((_, index) => ({ index, supported: true })),
        unresolvedSourceIds: [],
      }),
      usage,
    });
    const { interpretation: draft } =
      await interpretMatchingCandidateChunk(request);
    expect(draft.assertions).toHaveLength(20);
    const { interpretation } = await verifyMatchingCandidateChunk({
      ...request,
      draft,
    });
    expect(interpretation.assertions).toHaveLength(20);
    const [messages] = mocks.chat.mock.calls[1];
    const serialized = messages[2].content;
    expect(Buffer.byteLength(serialized)).toBeLessThan(8_192);
    expect(JSON.parse(serialized).passages).toEqual([quote]);
  });

  it('rejects drafts over the total assertion limit even when each activity group fits', async () => {
    const assertions = Array.from({ length: 65 }, (_, index) => ({
      ...wire.assertions[0],
      activityQuote: index < 32 ? text : null,
    }));
    const content = serializeDraft({ ...wire, assertions });
    expect(JSON.parse(content).activities).toHaveLength(2);
    mocks.chat.mockResolvedValueOnce({ content, usage });
    await expect(
      interpretMatchingCandidateChunk(options),
    ).rejects.toMatchObject({
      code: 'candidate_interpretation_output',
      detail: 'draft_envelope',
    });
    expect(mocks.settle).toHaveBeenCalledWith(250, 'actual');
  });

  it.each([
    { decisions: [], unresolvedSourceIds: [] },
    { decisions: [{ index: 1, supported: true }], unresolvedSourceIds: [] },
    {
      decisions: [{ index: 0, supported: true }],
      unresolvedSourceIds: ['source-2'],
    },
    {
      decisions: [{ index: 0, supported: true }],
      unresolvedSourceIds: ['source-1', 'source-1'],
    },
  ])('rejects malformed verifier coverage after accounting for usage', async (output) => {
    const draft = {
      assertions: [{ ...wire.assertions[0], sourceId: source.id }],
      reviewedSourceIds: [source.id],
      unresolvedSourceIds: [],
    };
    mocks.chat.mockResolvedValue({ content: JSON.stringify(output), usage });
    await expect(
      verifyMatchingCandidateChunk({ ...options, draft }),
    ).rejects.toMatchObject({
      code: 'candidate_interpretation_output',
    });
    expect(mocks.settle).toHaveBeenCalledWith(5_000, 'actual');
  });

  it('refuses a mismatched workspace before profile or budget lookup', async () => {
    mocks.currentSubject.mockReturnValue({
      ...subject,
      profileId: 'another-profile',
    });
    await expect(
      interpretMatchingCandidateChunk(options),
    ).rejects.toMatchObject({
      code: 'candidate_interpretation_authority',
    });
    expect(mocks.profile).not.toHaveBeenCalled();
    expect(mocks.reserve).not.toHaveBeenCalled();
    expect(mocks.chat).not.toHaveBeenCalled();
  });

  it('never invokes the private provider for a budget refusal', async () => {
    mocks.reserve.mockRejectedValue(
      new AiUsageRefusedError('user_budget_exhausted', 'Budget exhausted.'),
    );
    await expect(
      interpretMatchingCandidateChunk(options),
    ).rejects.toMatchObject({
      code: 'user_budget_exhausted',
    });
    expect(mocks.fence).not.toHaveBeenCalled();
    expect(mocks.chat).not.toHaveBeenCalled();
  });

  it('returns the reservation if the material fence refuses the call', async () => {
    mocks.fence.mockRejectedValue(new Error('Private fence details'));
    await expect(
      interpretMatchingCandidateChunk(options),
    ).rejects.toMatchObject({
      code: 'candidate_interpretation_fence_failed',
      message: 'candidate_interpretation_fence_failed',
    });
    expect(mocks.release).toHaveBeenCalledOnce();
    expect(mocks.chat).not.toHaveBeenCalled();
    expect(mocks.settle).not.toHaveBeenCalled();
  });

  it.each([
    { content: 'not JSON', detail: 'response_json' },
    { content: '{"private_field":"candidate output"}', detail: 'draft_schema' },
    {
      content: serializeDraft({ ...wire, reviewedSourceIds: ['source-3'] }),
      detail: 'draft_coverage',
    },
  ])('rejects malformed drafts with fixed diagnostics and accounts for provider usage', async ({
    content,
    detail,
  }) => {
    mocks.chat.mockResolvedValue({ content, usage });
    await expect(
      interpretMatchingCandidateChunk(options),
    ).rejects.toMatchObject({
      code: 'candidate_interpretation_output',
      message: 'candidate_interpretation_output',
      detail,
    });
    expect(mocks.settle).toHaveBeenCalledWith(250, 'actual');
    expect(mocks.chat).toHaveBeenCalledOnce();
  });

  it.each([
    { reviewedSourceIds: ['source-2'], unresolvedSourceIds: [] },
    {
      reviewedSourceIds: ['source-1', 'source-2', 'source-1'],
      unresolvedSourceIds: [],
    },
    {
      reviewedSourceIds: ['source-1', 'source-2'],
      unresolvedSourceIds: ['source-1'],
    },
    {
      reviewedSourceIds: ['source-2'],
      unresolvedSourceIds: ['source-1', 'source-1'],
    },
  ])('keeps claims from ambiguously accounted sources unresolved through verification', async (coverage) => {
    const second = { ...source, id: 'position:second-private' };
    const chunk = { ...options, input: { evidence: [source, second] } };
    mocks.chat.mockResolvedValueOnce({
      content: serializeDraft({ ...wire, ...coverage }),
      usage,
    });
    const { interpretation: draft } =
      await interpretMatchingCandidateChunk(chunk);
    expect(draft).toEqual({
      assertions: [{ ...wire.assertions[0], sourceId: source.id }],
      reviewedSourceIds: [second.id],
      unresolvedSourceIds: [source.id],
    });
    mocks.chat.mockResolvedValueOnce({
      content: JSON.stringify({
        decisions: [{ index: 0, supported: true }],
        unresolvedSourceIds: [],
      }),
      usage,
    });
    await expect(
      verifyMatchingCandidateChunk({ ...chunk, draft }),
    ).resolves.toMatchObject({
      interpretation: draft,
    });
  });

  it.each([
    { sourceId: 'source-3' },
    { conceptId: 'nonexistent-candidate-concept' },
    { period: { start: '2023', end: '2025' } },
    { quote: 'Invented PostgreSQL production work' },
  ])('keeps attributed siblings when a candidate assertion has invalid attribution', async (change) => {
    mocks.chat.mockResolvedValue({
      content: serializeDraft({
        ...wire,
        assertions: [wire.assertions[0], { ...wire.assertions[0], ...change }],
      }),
      usage,
    });

    await expect(
      interpretMatchingCandidateChunk(options),
    ).resolves.toMatchObject({
      interpretation: {
        assertions: [{ ...wire.assertions[0], sourceId: source.id }],
        reviewedSourceIds: [],
        unresolvedSourceIds: [source.id],
      },
    });
    expect(mocks.settle).toHaveBeenCalledWith(250, 'actual');
  });

  it('marks the misattributed source unresolved and preserves a valid assertion from another source', async () => {
    const second = {
      id: 'position:second-private',
      kind: 'experience' as const,
      text: 'Built a different tool for community volunteers.',
    };
    mocks.chat.mockResolvedValue({
      content: serializeDraft({
        ...wire,
        assertions: [
          wire.assertions[0],
          { ...wire.assertions[0], sourceId: 'source-2' },
        ],
        reviewedSourceIds: ['source-1', 'source-2'],
      }),
      usage,
    });
    await expect(
      interpretMatchingCandidateChunk({
        ...options,
        input: { evidence: [source, second] },
      }),
    ).resolves.toMatchObject({
      interpretation: {
        assertions: [{ ...wire.assertions[0], sourceId: source.id }],
        reviewedSourceIds: [source.id],
        unresolvedSourceIds: [second.id],
      },
    });
  });

  it('preserves an explicit activity duration bound for verification', async () => {
    const quote =
      'Optimized PostgreSQL queries for at least six years in production.';
    const duration = {
      minimumYears: 6,
      maximumYears: null,
      entirePosition: false,
    };
    const assertion = { ...wire.assertions[0], quote, duration };
    const input = { evidence: [{ ...source, text: quote }] };
    mocks.chat.mockResolvedValueOnce({
      content: serializeDraft({
        ...wire,
        assertions: [
          assertion,
          { ...assertion, duration: { ...duration, minimumYears: 7 } },
        ],
      }),
      usage,
    });
    mocks.chat.mockResolvedValueOnce({
      content: JSON.stringify({
        decisions: [{ index: 0, supported: true }],
        unresolvedSourceIds: [],
      }),
      usage,
    });
    const { interpretation: draft } = await interpretMatchingCandidateChunk({
      ...options,
      input,
    });
    expect(draft).toEqual({
      assertions: [{ ...assertion, sourceId: source.id }],
      reviewedSourceIds: [],
      unresolvedSourceIds: [source.id],
    });
    await expect(
      verifyMatchingCandidateChunk({ ...options, input, draft }),
    ).resolves.toMatchObject({
      interpretation: draft,
    });
    const [messages] = mocks.chat.mock.calls[1];
    expect(JSON.parse(messages[2].content).assertions[0].at(-1)).toEqual(
      duration,
    );
  });

  it('exposes only a trusted position flag for a linked whole-tenure claim', async () => {
    const quote =
      'Optimized PostgreSQL queries in production throughout my entire tenure.';
    const linked = {
      ...source,
      kind: 'experience' as const,
      text: quote,
      activityId: 'private-linked-activity',
      activityPosition: {
        role: 'Private linked role',
        start: '2015',
        end: '2024',
      },
    };
    const duration = {
      minimumYears: null,
      maximumYears: null,
      entirePosition: true,
    };
    const assertion = { ...wire.assertions[0], quote, duration };
    mocks.chat.mockResolvedValue({
      content: serializeDraft({ ...wire, assertions: [assertion] }),
      usage,
    });
    await expect(
      interpretMatchingCandidateChunk({
        ...options,
        input: { evidence: [linked] },
      }),
    ).resolves.toMatchObject({
      interpretation: {
        assertions: [{ ...assertion, sourceId: source.id }],
        reviewedSourceIds: [source.id],
      },
    });
    const [messages] = mocks.chat.mock.calls[0];
    expect(JSON.parse(messages[1].content).sources).toEqual([
      {
        id: 'source-1',
        kind: 'experience',
        isPosition: false,
        hasTrustedPosition: true,
        text: quote,
      },
    ]);
  });

  it('deduplicates identical claims but discards conflicting claim properties', async () => {
    const unrelated = {
      ...wire.assertions[0],
      conceptId: 'database-performance-tuning',
    };
    mocks.chat.mockResolvedValue({
      content: serializeDraft({
        ...wire,
        assertions: [
          wire.assertions[0],
          wire.assertions[0],
          { ...wire.assertions[0], support: 'stated' },
          unrelated,
          unrelated,
        ],
      }),
      usage,
    });
    await expect(
      interpretMatchingCandidateChunk(options),
    ).resolves.toMatchObject({
      interpretation: {
        assertions: [{ ...unrelated, sourceId: source.id }],
        reviewedSourceIds: [],
        unresolvedSourceIds: [source.id],
      },
    });
  });

  it('settles conservatively for an ambiguous provider failure without retrying or retaining details', async () => {
    mocks.chat.mockRejectedValue(new Error(text));
    await expect(
      interpretMatchingCandidateChunk(options),
    ).rejects.toMatchObject({
      code: 'candidate_interpretation_provider_failed',
      message: 'candidate_interpretation_provider_failed',
    });
    const [reserved] = mocks.reserve.mock.calls[0];
    expect(mocks.settle).toHaveBeenCalledWith(reserved.micros, 'conservative');
    expect(mocks.chat).toHaveBeenCalledOnce();
    expect(mocks.release).not.toHaveBeenCalled();
  });

  it.each<{
    completion: Partial<AIResponse>;
    detail: string;
  }>([
    { completion: { finishReason: 'length' }, detail: 'response_length' },
    { completion: { truncated: true }, detail: 'response_length' },
    {
      completion: { finishReason: 'content_filter', truncated: true },
      detail: 'content_filter',
    },
    {
      completion: { finishReason: 'tool_calls', truncated: true },
      detail: 'unexpected_finish',
    },
    {
      completion: { finishReason: 'length', parts: 2 },
      detail: 'multipart_response',
    },
    {
      completion: {
        finishReason: 'length',
        usage: {
          promptTokens: 2_000,
          completionTokens: 6_000,
          totalTokens: 8_000,
        },
      },
      detail: 'usage_limit',
    },
  ])('settles usage and distinguishes incomplete responses as $detail', async ({
    completion,
    detail,
  }) => {
    const response: AIResponse = {
      content: serializeDraft(wire),
      usage,
      ...completion,
    };
    mocks.chat.mockResolvedValue(response);
    await expect(
      interpretMatchingCandidateChunk(options),
    ).rejects.toMatchObject({
      code: 'candidate_interpretation_provider_incomplete',
      detail,
    });
    expect(mocks.settle).toHaveBeenCalledWith(expect.any(Number), 'actual');
    expect(mocks.chat).toHaveBeenCalledOnce();
  });

  it('settles conservatively and rejects missing usage', async () => {
    const response: AIResponse = {
      content: serializeDraft(wire),
      finishReason: 'length',
    };
    mocks.chat.mockResolvedValue(response);
    await expect(
      interpretMatchingCandidateChunk(options),
    ).rejects.toMatchObject({
      code: 'candidate_interpretation_usage',
      detail: 'usage_missing_or_invalid',
    });
    const [reserved] = mocks.reserve.mock.calls[0];
    expect(mocks.settle).toHaveBeenCalledWith(reserved.micros, 'conservative');
  });
});
