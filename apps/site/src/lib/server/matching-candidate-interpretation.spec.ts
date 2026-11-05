import type { AIResponse } from '@happyvertical/ai';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AiUsageRefusedError } from './ai-usage-guard.js';
import {
  type CandidateInterpretation,
  candidateInterpretationConcepts,
} from './matching-candidate-contract.js';
import {
  chunkMatchingCandidateEvidence,
  estimateMatchingCandidateInterpretation,
  interpretMatchingCandidateChunk,
  matchingCandidateDraftRequestId,
  matchingCandidateRepairRequestId,
  matchingCandidateVerificationRequestId,
  reconcileCandidateRepair,
  repairMatchingCandidateChunk,
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
      'Preserve production when the passage establishes both',
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
    expect(chunks.length).toBeGreaterThanOrEqual(3);
    expect(chunks.every(({ evidence }) => evidence.length <= 24)).toBe(true);
    expect(chunks.flatMap((chunk) => chunk.evidence)).toEqual(evidence);
    expect(chunkMatchingCandidateEvidence({ evidence }, vocabulary)).toEqual(
      chunks,
    );
    expect(
      estimateMatchingCandidateInterpretation({ evidence }, vocabulary),
    ).toEqual({
      chunks: chunks.length,
      requests: chunks.length * 4,
      sources: 50,
      estimatedInputTokens: expect.any(Number),
      reservedSpendMicros: expect.any(Number),
      draftAndVerificationReservedSpendMicros: expect.any(Number),
      largestStageReservationMicros: expect.any(Number),
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
      maxTokens: 6_144,
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
      sourceCoverage: [{ sourceId: source.id, issues: [] }],
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
        priorChallenges: [],
        decisions: [
          { index: 1, reason: 'concept', omitted: [] },
          { index: 0, reason: 'accepted', omitted: [] },
        ],
        sourceCoverage: [{ sourceId: 'source-1', issues: [] }],
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
      reviewedSourceIds: [source.id],
      unresolvedSourceIds: [],
      sourceCoverage: [{ sourceId: source.id, issues: [] }],
    });
    const [messages, chatOptions] = mocks.chat.mock.calls[1];
    expect(messages[0].content).toContain('Independently verify');
    expect(messages[1].content).toContain(text);
    expect(JSON.parse(messages[1].content).implications).toContainEqual([
      draftConceptId('backend-development'),
      expect.arrayContaining([draftConceptId('software-development')]),
    ]);
    expect(messages[1].content).toContain('Node.js');
    expect(messages[2].content).not.toContain('nodejs');
    expect(messages[2].content).toContain(draftConceptId('system-scalability'));
    expect(JSON.stringify(messages)).not.toContain(source.id);
    expect(chatOptions).toMatchObject({
      model: 'openai/gpt-6.1-sol',
      maxTokens: 4_096,
      reasoning: { effort: 'low', maxTokens: 1_024 },
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
              sourceCoverage: {
                items: { properties: { sourceId: { enum: ['source-1'] } } },
              },
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

  it('shares the attributed work rubric and rejects mere supervision and unperformed assignments', async () => {
    const quotes = [
      'In my role I was directly accountable for running scheduled rollouts for the live service.',
      'I supervised the team. My colleague performed the production deployments.',
      'I was assigned the production rollout, but I never carried it out.',
    ];
    const records = quotes.map((quote, index) => ({
      ...source,
      id: `operation-${index}`,
      text: quote,
      kind: 'experience' as const,
    }));
    const aliases = ['source-1', 'source-2', 'source-3'];
    mocks.chat
      .mockResolvedValueOnce({
        content: serializeDraft({
          ...wire,
          reviewedSourceIds: aliases,
          assertions: quotes.map((quote, index) => ({
            ...wire.assertions[0],
            sourceId: aliases[index],
            conceptId: 'service-deployment',
            quote,
          })),
        }),
        usage,
      })
      .mockResolvedValueOnce({
        content: JSON.stringify({
          decisions: [
            { index: 0, reason: 'accepted', omitted: [] },
            { index: 1, reason: 'actor', omitted: [] },
            { index: 2, reason: 'polarity', omitted: [] },
          ],
          priorChallenges: [],
          sourceCoverage: aliases.map((sourceId) => ({ sourceId, issues: [] })),
        }),
        usage,
      });
    const request = { ...options, input: { evidence: records } };
    const { interpretation: draft } =
      await interpretMatchingCandidateChunk(request);
    const { interpretation } = await verifyMatchingCandidateChunk({
      ...request,
      draft,
    });
    expect(interpretation.assertions).toEqual([
      expect.objectContaining({ quote: quotes[0], support: 'action' }),
    ]);
    for (const [messages] of mocks.chat.mock.calls)
      expect(messages[0].content).toContain(
        'Explicit first-person responsibility for specific operations',
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
        priorChallenges: [],
        decisions: [],
        sourceCoverage: [
          {
            sourceId: 'source-1',
            issues: [
              {
                kind: 'omitted-positive',
                conceptId: draftConceptId('postgresql'),
                quote: text,
              },
            ],
          },
        ],
      }),
      usage,
    });
    const result = await verifyMatchingCandidateChunk({ ...options, draft });
    expect(mocks.chat.mock.calls[0][0][1].content).toContain('PostgreSQL');
    expect(result.interpretation).toEqual({
      assertions: [],
      reviewedSourceIds: [],
      unresolvedSourceIds: [source.id],
      sourceCoverage: [
        {
          sourceId: source.id,
          issues: [
            { kind: 'omitted-positive', conceptId: 'postgresql', quote: text },
          ],
        },
      ],
    });
  });

  it.each([
    { kind: 'omitted-positive', conceptId: null, quote: text },
    { kind: 'omitted-positive', conceptId: 'c9999', quote: text },
    {
      kind: 'omitted-positive',
      conceptId: draftConceptId('postgresql'),
      quote: 'Invented quote',
    },
    { kind: 'unread', conceptId: draftConceptId('postgresql'), quote: text },
  ])('rejects malformed diagnostics after settling provider usage', async (issue) => {
    mocks.chat.mockResolvedValue({
      content: JSON.stringify({
        priorChallenges: [],
        decisions: [],
        sourceCoverage: [{ sourceId: 'source-1', issues: [issue] }],
      }),
      usage,
    });
    const draft = {
      assertions: [],
      reviewedSourceIds: [source.id],
      unresolvedSourceIds: [],
    };
    await expect(
      verifyMatchingCandidateChunk({ ...options, draft }),
    ).rejects.toMatchObject({
      code: 'candidate_interpretation_output',
    });
    expect(mocks.settle).toHaveBeenCalledWith(5_000, 'actual');
  });

  it.each([
    'accepted',
    'context',
  ] as const)('audits a repair and its previously verified fallback independently (%s)', async (revisionReason) => {
    const denial = 'I have never used Node.js in production.';
    const unknownRestriction = 'I have limits I cannot describe.';
    const capture = {
      ...source,
      text: [text, denial, unknownRestriction].join(' '),
    };
    const request = { ...options, input: { evidence: [capture] } };
    const initialClaim = {
      ...wire.assertions[0],
      sourceId: source.id,
      context: null,
    };
    const scopedDenial = {
      ...wire.assertions[0],
      sourceId: source.id,
      quote: denial,
      conceptId: 'nodejs',
      support: 'stated' as const,
      polarity: 'negative' as const,
    };
    const omitted = {
      kind: 'omitted-positive',
      conceptId: 'postgresql',
      quote: text,
    } as const;
    const restriction = {
      kind: 'unassessed-restriction',
      conceptId: null,
      quote: unknownRestriction,
    } as const;
    const verified: CandidateInterpretation = {
      assertions: [initialClaim, scopedDenial],
      reviewedSourceIds: [],
      unresolvedSourceIds: [source.id],
      sourceCoverage: [{ sourceId: source.id, issues: [omitted, restriction] }],
    };
    const revised = { ...initialClaim, context: 'production' as const };
    const { activities } = JSON.parse(
      serializeDraft({
        ...wire,
        assertions: [{ ...revised, sourceId: 'source-1' }],
      }),
    );
    mocks.chat
      .mockResolvedValueOnce({
        content: JSON.stringify({ activities }),
        usage,
      })
      .mockResolvedValueOnce({
        content: JSON.stringify({
          priorChallenges: [],
          decisions: [{ index: 0, reason: revisionReason, omitted: [] }],
          sourceCoverage: [{ sourceId: 'source-1', issues: [] }],
        }),
        usage,
      });
    const repairRequest = { ...request, verified };
    const repair = await repairMatchingCandidateChunk(repairRequest);
    expect(repair.requestId).toBe(
      matchingCandidateRepairRequestId(repairRequest),
    );
    expect(repair.requestId).not.toBe(matchingCandidateDraftRequestId(request));
    expect(repair.interpretation.assertions).toEqual([revised, scopedDenial]);
    const [repairMessages] = mocks.chat.mock.calls[0];
    expect(repairMessages[1].content).toContain(denial);
    expect(repairMessages[3].content).toContain('omitted-positive');
    expect(JSON.stringify(repairMessages)).not.toContain(source.id);
    const audited = await verifyMatchingCandidateChunk({
      ...request,
      requestId: 'opaque-repair-audit-0001',
      draft: repair.interpretation,
      prior: verified,
    });
    const strong = revisionReason === 'accepted';
    expect(reconcileCandidateRepair(verified, audited.interpretation)).toEqual({
      assertions: [strong ? revised : initialClaim, scopedDenial],
      reviewedSourceIds: [],
      unresolvedSourceIds: [source.id],
      sourceCoverage: [
        {
          sourceId: source.id,
          issues: strong ? [restriction] : [omitted, restriction],
        },
      ],
    });
    expect(mocks.fence).toHaveBeenCalledTimes(2);
  });

  it('tracks restrictions independently even when the verifier rejects a known proposed denial', async () => {
    const quote = 'I have never used PostgreSQL in production.';
    const request = {
      ...options,
      input: { evidence: [{ ...source, text: quote }] },
    };
    const assertion = {
      ...wire.assertions[0],
      sourceId: source.id,
      quote,
      support: 'stated' as const,
      polarity: 'negative' as const,
    };
    mocks.chat.mockResolvedValue({
      content: JSON.stringify({
        priorChallenges: [],
        decisions: [{ index: 0, reason: 'projection', omitted: ['context'] }],
        sourceCoverage: [{ sourceId: 'source-1', issues: [] }],
      }),
      usage,
    });
    const { interpretation } = await verifyMatchingCandidateChunk({
      ...request,
      draft: {
        assertions: [assertion],
        reviewedSourceIds: [source.id],
        unresolvedSourceIds: [],
      },
    });
    expect(interpretation).toEqual({
      assertions: [],
      reviewedSourceIds: [],
      unresolvedSourceIds: [source.id],
      sourceCoverage: [
        {
          sourceId: source.id,
          issues: [
            { kind: 'unassessed-restriction', conceptId: 'postgresql', quote },
          ],
        },
      ],
    });
  });

  it('retains a verified standalone action after an atomic projection but cannot salvage an unsupported tool binding', async () => {
    const quote =
      'From 2020-01-01 through 2024-12-31 I instrumented traces for a customer-facing service.';
    const activityQuote = `${quote} For a separate prototype, I reviewed PostgreSQL query plans.`;
    const input = { evidence: [{ ...source, text: activityQuote }] };
    const claim = {
      ...wire.assertions[0],
      conceptId: 'observability',
      sourceId: source.id,
      quote,
      activityQuote,
      period: { start: '2020-01-01', end: '2024-12-31' },
    };
    const unsupported = {
      ...claim,
      conceptId: 'database-performance-tuning',
      quote: activityQuote,
    };
    const draft = {
      assertions: [claim, unsupported],
      reviewedSourceIds: [source.id],
      unresolvedSourceIds: [],
      sourceCoverage: [{ sourceId: source.id, issues: [] }],
    };
    mocks.chat.mockResolvedValue({
      content: JSON.stringify({
        priorChallenges: [
          {
            index: 0,
            reason: 'projection',
            omitted: ['context', 'time', 'activity'],
            quote: activityQuote,
          },
        ],
        decisions: [{ index: 0, reason: 'binding', omitted: [] }],
        sourceCoverage: [{ sourceId: 'source-1', issues: [] }],
      }),
      usage,
    });
    const { interpretation } = await verifyMatchingCandidateChunk({
      ...options,
      input,
      draft,
      prior: { ...draft, assertions: [claim] },
    });
    expect(interpretation.assertions).toEqual([
      { ...claim, context: null, period: null, activityQuote: null },
    ]);
  });

  it.each([
    'unrelated',
    'actor',
    'invalid-attribution',
  ] as const)('checks %s repair changes against a prior independently verified ledger', async (scenario) => {
    const production =
      'I maintained the customer-facing backend using Node.js.';
    const actor = 'My colleague actually maintained that backend.';
    const denial = 'I have never used PostgreSQL in production.';
    const deltaQuote = 'I built a React dashboard.';
    const capture = {
      ...source,
      text: [production, actor, denial, deltaQuote].join(' '),
    };
    const work = {
      ...wire.assertions[0],
      sourceId: source.id,
      conceptId: 'nodejs',
      quote: production,
    };
    const limit = {
      ...wire.assertions[0],
      sourceId: source.id,
      support: 'stated' as const,
      polarity: 'negative' as const,
      quote: denial,
    };
    const delta = {
      ...work,
      conceptId: 'react',
      context: null,
      quote: deltaQuote,
    };
    const prior = {
      assertions: [work, limit],
      reviewedSourceIds: [source.id],
      unresolvedSourceIds: [],
      sourceCoverage: [{ sourceId: source.id, issues: [] }],
    };
    const challenges =
      scenario === 'unrelated'
        ? []
        : [
            {
              index: 0,
              reason: 'actor',
              omitted: [],
              quote:
                scenario === 'actor' ? actor : 'An invented actor passage.',
            },
            { index: 1, reason: 'scope', omitted: [], quote: denial },
          ];
    mocks.chat.mockResolvedValue({
      content: JSON.stringify({
        decisions: [{ index: 0, reason: 'accepted', omitted: [] }],
        priorChallenges: challenges,
        sourceCoverage: [{ sourceId: 'source-1', issues: [] }],
      }),
      usage,
    });
    const result = verifyMatchingCandidateChunk({
      ...options,
      input: { evidence: [capture] },
      prior,
      draft: { ...prior, assertions: [...prior.assertions, delta] },
    });
    if (scenario === 'invalid-attribution') {
      await expect(result).rejects.toMatchObject({
        detail: 'verifier_attribution',
      });
      return;
    }
    const { interpretation } = await result;
    const [messages] = mocks.chat.mock.calls[0];
    const payload = JSON.parse(messages[2].content);
    expect(payload.assertions).toHaveLength(1);
    expect(payload.previouslyVerified).toHaveLength(2);
    expect(interpretation.assertions).toEqual(
      scenario === 'unrelated' ? [work, limit, delta] : [delta],
    );
    if (scenario === 'actor')
      expect(interpretation.sourceCoverage?.[0].issues).toEqual([
        {
          kind: 'unassessed-restriction',
          conceptId: 'postgresql',
          quote: denial,
        },
      ]);
  });

  it('accepts an independently checked correction to challenged dates without clearing a restriction', async () => {
    const quote =
      'The customer-facing service ran from 2018-01-01 to 2024-12-31. I maintained its Node.js backend from 2020-01-01 to 2024-12-31.';
    const capture = { ...source, text: quote };
    const request = { ...options, input: { evidence: [capture] } };
    const old = {
      ...wire.assertions[0],
      sourceId: source.id,
      conceptId: 'nodejs',
      quote,
      period: { start: '2018-01-01', end: '2024-12-31' },
    };
    const revised = {
      ...old,
      period: { start: '2020-01-01', end: '2024-12-31' },
    };
    const restriction = {
      kind: 'unassessed-restriction',
      conceptId: null,
      quote: null,
    } as const;
    const prior: CandidateInterpretation = {
      assertions: [old],
      reviewedSourceIds: [],
      unresolvedSourceIds: [source.id],
      sourceCoverage: [
        {
          sourceId: source.id,
          issues: [
            { kind: 'omitted-positive', conceptId: 'nodejs', quote },
            restriction,
          ],
        },
      ],
    };
    const { activities } = JSON.parse(
      serializeDraft({
        ...wire,
        assertions: [{ ...revised, sourceId: 'source-1' }],
      }),
    );
    mocks.chat
      .mockResolvedValueOnce({ content: JSON.stringify({ activities }), usage })
      .mockResolvedValueOnce({
        content: JSON.stringify({
          decisions: [{ index: 0, reason: 'accepted', omitted: [] }],
          priorChallenges: [
            { index: 0, reason: 'projection', omitted: ['time'], quote },
          ],
          sourceCoverage: [{ sourceId: 'source-1', issues: [] }],
        }),
        usage,
      });
    const { interpretation: draft } = await repairMatchingCandidateChunk({
      ...request,
      verified: prior,
    });
    const { interpretation } = await verifyMatchingCandidateChunk({
      ...request,
      draft,
      prior,
      requestId: 'opaque-repair-audit-0002',
    });
    const result = reconcileCandidateRepair(prior, interpretation);
    expect(result.assertions).toEqual([revised]);
    expect(result.sourceCoverage?.[0].issues).toContainEqual(restriction);
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
        priorChallenges: [],
        decisions: [{ index: 0, reason: 'accepted', omitted: [] }],
        sourceCoverage: [{ sourceId: 'source-1', issues: [] }],
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
    expect(interpretation).toEqual({
      ...draft,
      sourceCoverage: draft.sourceCoverage?.map(({ sourceId, issues }) => ({
        sourceId,
        issues: issues.filter(({ kind }) => kind !== 'unread'),
      })),
    });
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
        priorChallenges: [],
        decisions: [
          { index: 0, reason: 'accepted', omitted: [] },
          { index: 1, reason: 'concept', omitted: [] },
        ],
        sourceCoverage: [{ sourceId: 'source-1', issues: [] }],
      }),
      usage,
    });
    const { interpretation: draft } =
      await interpretMatchingCandidateChunk(request);
    expect(draft.assertions).toHaveLength(2);
    const verified = await verifyMatchingCandidateChunk({ ...request, draft });
    expect(verified.interpretation).toEqual({
      assertions: [{ ...deployed, sourceId: capture.id }],
      reviewedSourceIds: [capture.id],
      unresolvedSourceIds: [],
      sourceCoverage: [{ sourceId: capture.id, issues: [] }],
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
    expect(interpretation).toMatchObject({
      assertions: [],
      reviewedSourceIds: [],
      unresolvedSourceIds: [capture.id],
      sourceCoverage: [
        {
          sourceId: capture.id,
          issues: [
            { kind: 'unread', conceptId: null, quote: null },
            {
              kind: 'unassessed-restriction',
              conceptId: 'postgresql',
              quote: 'I have never used PostgreSQL',
            },
          ],
        },
      ],
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
        priorChallenges: [],
        decisions: assertions.map((_, index) => ({
          index,
          reason: 'accepted',
          omitted: [],
        })),
        sourceCoverage: [{ sourceId: 'source-1', issues: [] }],
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
    {
      priorChallenges: [],
      decisions: [],
      sourceCoverage: [{ sourceId: 'source-1', issues: [] }],
    },
    {
      priorChallenges: [],
      decisions: [{ index: 1, reason: 'accepted', omitted: [] }],
      sourceCoverage: [{ sourceId: 'source-1', issues: [] }],
    },
    {
      priorChallenges: [],
      decisions: [{ index: 0, reason: 'accepted', omitted: [] }],
      sourceCoverage: [{ sourceId: 'source-2', issues: [] }],
    },
    {
      priorChallenges: [],
      decisions: [{ index: 0, reason: 'accepted', omitted: [] }],
      sourceCoverage: [
        { sourceId: 'source-1', issues: [] },
        { sourceId: 'source-1', issues: [] },
      ],
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
  ])('lets the independent full-source audit resolve incomplete draft accounting', async (coverage) => {
    const second = { ...source, id: 'position:second-private' };
    const chunk = { ...options, input: { evidence: [source, second] } };
    mocks.chat.mockResolvedValueOnce({
      content: serializeDraft({ ...wire, ...coverage }),
      usage,
    });
    const { interpretation: draft } =
      await interpretMatchingCandidateChunk(chunk);
    expect(draft).toMatchObject({
      assertions: [{ ...wire.assertions[0], sourceId: source.id }],
      reviewedSourceIds: [second.id],
      unresolvedSourceIds: [source.id],
    });
    mocks.chat.mockResolvedValueOnce({
      content: JSON.stringify({
        priorChallenges: [],
        decisions: [{ index: 0, reason: 'accepted', omitted: [] }],
        sourceCoverage: [
          { sourceId: 'source-1', issues: [] },
          { sourceId: 'source-2', issues: [] },
        ],
      }),
      usage,
    });
    await expect(
      verifyMatchingCandidateChunk({ ...chunk, draft }),
    ).resolves.toMatchObject({
      interpretation: {
        assertions: draft.assertions,
        reviewedSourceIds: [source.id, second.id],
        unresolvedSourceIds: [],
        sourceCoverage: [
          { sourceId: source.id, issues: [] },
          { sourceId: second.id, issues: [] },
        ],
      },
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
        priorChallenges: [],
        decisions: [{ index: 0, reason: 'accepted', omitted: [] }],
        sourceCoverage: [{ sourceId: 'source-1', issues: [] }],
      }),
      usage,
    });
    const { interpretation: draft } = await interpretMatchingCandidateChunk({
      ...options,
      input,
    });
    expect(draft).toMatchObject({
      assertions: [{ ...assertion, sourceId: source.id }],
      reviewedSourceIds: [],
      unresolvedSourceIds: [source.id],
    });
    await expect(
      verifyMatchingCandidateChunk({ ...options, input, draft }),
    ).resolves.toMatchObject({
      interpretation: {
        assertions: draft.assertions,
        reviewedSourceIds: [source.id],
        unresolvedSourceIds: [],
      },
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
          completionTokens: 8_000,
          totalTokens: 10_000,
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
