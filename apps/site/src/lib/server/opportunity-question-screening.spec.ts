import type { DecisionResult } from '@happyvertical/ai';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createScreeningQuestion,
  type ScreeningQuestion,
} from '../opportunity-screening-questions.js';
import {
  estimateJevInputTokens,
  evaluateOpportunityQuestionScreening,
  OPPORTUNITY_QUESTION_SCREENING_OVERFLOW_VERSION,
  OPPORTUNITY_QUESTION_SCREENING_V1_VERSION,
  OPPORTUNITY_QUESTION_SCREENING_V2_VERSION,
  OPPORTUNITY_QUESTION_SCREENING_V3_VERSION,
  OPPORTUNITY_QUESTION_SCREENING_V4_VERSION,
  OPPORTUNITY_QUESTION_SCREENING_V5_VERSION,
  OPPORTUNITY_QUESTION_SCREENING_V6_VERSION,
  OPPORTUNITY_QUESTION_SCREENING_V7_VERSION,
  OPPORTUNITY_QUESTION_SCREENING_VERSION,
  type OpportunityQuestionScreeningOptions,
  opportunityQuestionScreeningInputFingerprint,
  type PreparedOpportunityQuestionScreening,
  preflightOpportunityQuestionScreening,
  prepareOpportunityQuestionScreening,
  prepareOpportunityRolePreScreen,
  resolveOpportunityQuestionScreening,
} from './opportunity-question-screening.js';
import { fingerprintOpportunitySourceContent } from './opportunity-source-content.js';
import type { CandidateEvidenceSource } from './resume-data.js';

const mocks = vi.hoisted(() => ({
  decide: vi.fn(),
  getAI: vi.fn(),
  governed: vi.fn(),
  attach: vi.fn(),
}));
vi.mock('@happyvertical/ai', () => ({ getAI: mocks.getAI }));
vi.mock('./private-workspace.js', () => ({
  requireWorkspaceSubject: (subject: {
    tenantId: string;
    userId: string;
    profileId: string;
  }) => {
    if (!subject.tenantId || !subject.userId || !subject.profileId)
      throw new Error('owned subject required');
    return subject;
  },
}));
vi.mock('./opportunity-intelligence-governance.js', () => ({
  executeGovernedOpportunityIntelligenceRequest: mocks.governed,
  attachOpportunityIntelligenceInvocationMetadata: mocks.attach,
}));
vi.mock('./opportunity-intelligence-config.js', () => ({
  resolveOpportunityIntelligenceBudgetConfig: () => ({
    enabled: true,
    run: { inputTokens: 80000, calls: 4, spendMicros: 100000 },
    pricing: {},
  }),
  reservedRequestSpendMicros: () => 1000,
}));
const subject = { tenantId: 'tenant', userId: 'owner', profileId: 'profile' };
const identity = {
  requestId: 'actual-1',
  inputFingerprint: 'input-1',
  agentRunId: 'run-1',
};
const source = {
  title: 'Platform engineer',
  locationNotes: 'Remote - New Zealand',
  descriptionRaw:
    'Responsibilities\r\nBuild typed services 😀.\r\n3 years of service ownership.\r\n',
};
async function questions(): Promise<ScreeningQuestion[]> {
  return [
    await createScreeningQuestion({
      id: 'source',
      text: 'Does the posting explicitly allow remote work?',
      kind: 'source',
      importance: 'must_have',
      desiredAnswer: 'yes',
      weight: 1,
      active: true,
    }),
    await createScreeningQuestion({
      id: 'fit',
      text: 'Can I deliver typed services end to end?',
      kind: 'fit',
      importance: 'preference',
      desiredAnswer: 'yes',
      weight: 2,
      active: true,
    }),
  ];
}
function prepare(
  items: ScreeningQuestion[],
  count = 2,
  padding = 0,
  options: OpportunityQuestionScreeningOptions = {
    version: OPPORTUNITY_QUESTION_SCREENING_V6_VERSION,
  },
  captured: Record<string, unknown> = source,
) {
  return prepareOpportunityQuestionScreening(
    {
      opportunityId: 'role',
      sourceContentJson: JSON.stringify(captured),
      sourceContentFingerprint: fingerprintOpportunitySourceContent(captured),
      sourceContentVersion: 1,
      candidateMaterialFingerprint: 'candidate-current',
      candidateSources: Array.from({ length: count }, (_, index) => ({
        id: `fact:${index}`,
        kind: 'project' as const,
        title: `Project ${index}`,
        text: `Designed and deployed typed service ${index}.${'x'.repeat(padding)}`,
      })),
      questions: items,
    },
    options,
  );
}
function result(
  prepared: PreparedOpportunityQuestionScreening,
  ordinal = 2,
): DecisionResult {
  return {
    model: prepared.model,
    provenance: { provider: 'typesafe', model: prepared.model },
    usage: { promptTokens: 1000, completionTokens: 100, totalTokens: 1100 },
    answers: Object.fromEntries(
      Object.entries(prepared.request.questions).map(([key, question]) => {
        if (question.type === 'score') {
          const probabilities = Object.fromEntries(
            question.criteria.map((_, index) => [
              String(index),
              index === Math.min(ordinal, question.criteria.length - 1)
                ? 0.9
                : 0.1 / (question.criteria.length - 1),
            ]),
          );
          return [
            key,
            {
              type: 'score',
              score: Object.entries(probabilities).reduce(
                (sum, [level, probability]) =>
                  sum + Number(level) * probability,
                0,
              ),
              confidence: 0.8,
              levels: question.criteria,
              probabilities,
            },
          ];
        }
        if (question.type !== 'choice')
          throw new Error('unexpected fixture primitive');
        const keys = Object.keys(question.criteria);
        const selected = key.endsWith('_answer')
          ? 'yes'
          : key.endsWith('_candidate') || key.endsWith('_candidate_0')
            ? 'c0'
            : /_candidate_[12]$/u.test(key)
              ? 'none'
              : /_source_[12]$/u.test(key)
                ? 'none'
                : 's0';
        return [
          key,
          {
            type: 'choice',
            choice: selected,
            confidence: 0.9,
            probabilities: Object.fromEntries(
              keys.map((id) => [
                id,
                id === selected ? 0.9 : 0.1 / (keys.length - 1),
              ]),
            ),
          },
        ];
      }),
    ),
  };
}
function select(decision: DecisionResult, key: string, choice: string) {
  const answer = decision.answers[key];
  if (answer?.type !== 'choice') throw new Error('fixture choice needed');
  answer.choice = choice;
  const keys = Object.keys(answer.probabilities);
  if (keys.includes(choice))
    answer.probabilities = Object.fromEntries(
      keys.map((id) => [id, id === choice ? 0.9 : 0.1 / (keys.length - 1)]),
    );
}
beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv('TYPESAFE_API_KEY', 'test-key');
  vi.stubEnv('OPPORTUNITY_ASSESSMENT_DECISIONS_ENABLED', 'true');
  vi.stubEnv(
    'OPPORTUNITY_SKILL_DECISION_INPUT_COST_MICROS_PER_MILLION',
    '42000',
  );
  vi.stubEnv('OPPORTUNITY_SKILL_DECISION_OUTPUT_COST_MICROS_PER_MILLION', '0');
  mocks.getAI.mockResolvedValue({
    getCapabilities: async () => ({ decisions: true }),
    decide: mocks.decide,
  });
  mocks.attach.mockImplementation((error, metadata) =>
    Object.assign(error, { metadata }),
  );
  mocks.governed.mockImplementation(async (options) => ({
    output: (await options.invoke('actual-1')).output,
    requestId: 'actual-1',
    reused: false,
  }));
});
describe('question-driven current PRIVATE typed screening', () => {
  it('keeps the complete raw source/ATS and all155 facts once without prior AI verdicts', async () => {
    const prepared = prepare(await questions(), 155);
    const state = prepared.request.state;
    expect(JSON.stringify(state)).toContain('Remote - New Zealand');
    expect(prepared.candidateSourceCount).toBe(155);
    expect(
      Object.values(prepared.sourceWitnesses)
        .filter((item) => !item.sourceFieldPath)
        .map((item) => item.text)
        .join(''),
    ).toBe(source.descriptionRaw);
    expect(JSON.stringify(state)).not.toContain('sourceClassification');
    expect(JSON.stringify(state)).not.toContain('originalReview');
    expect(
      JSON.stringify(state).match(
        /Designed and deployed typed service 154\./gu,
      ),
    ).toHaveLength(1);
  });
  it('replays exact V1 single-witness request material while V2 has a distinct three-slot identity', async () => {
    const items = await questions();
    const legacy = prepare(items, 2, 0, {
      version: OPPORTUNITY_QUESTION_SCREENING_V1_VERSION,
    });
    const current = prepare(items);
    expect(legacy.version).toBe(OPPORTUNITY_QUESTION_SCREENING_V1_VERSION);
    expect(
      legacy.bindings.every((binding) => !Object.hasOwn(binding, 'sourceKeys')),
    ).toBe(true);
    expect(Object.keys(legacy.request.questions)).toEqual([
      'q0_source',
      'q0_alignment',
      'q0_candidate',
      'q1_source',
      'q1_answer',
    ]);
    expect(legacy.request.questions.q1_source!.instructions).toEqual({
      userQuestion: items.find((item) => item.kind === 'source')!.text,
      task: 'Choose the exact source witness ID in B or F that grounds the answer to userQuestion. Choose none for missing, ambiguous or irrelevant source evidence. The IDs refer to exact supplied text/field values.',
    });
    expect(current.version).toBe(OPPORTUNITY_QUESTION_SCREENING_V6_VERSION);
    expect(current.fingerprint).not.toBe(legacy.fingerprint);
    expect(current.request.state).toEqual(legacy.request.state);
    expect(
      current.bindings.every((binding) => binding.sourceKeys?.length === 3),
    ).toBe(true);
    expect(
      resolveOpportunityQuestionScreening(legacy, result(legacy), identity)
        .contractVersion,
    ).toBe(OPPORTUNITY_QUESTION_SCREENING_V1_VERSION);
  });
  it('keeps V2 replay stable and gives classification tuning a new current identity', async () => {
    const items = await questions();
    const previous = prepare(items, 2, 0, {
      version: OPPORTUNITY_QUESTION_SCREENING_V2_VERSION,
    });
    const current = prepare(items);
    expect(previous.request.state).toEqual(current.request.state);
    expect(previous.bindings).toEqual(
      current.bindings.map(
        ({ candidateKeys: _candidateKeys, ...binding }) => binding,
      ),
    );
    expect(previous.fingerprint).not.toBe(current.fingerprint);
    expect(JSON.stringify(previous.request.questions)).not.toContain(
      'different occupation',
    );
    expect(JSON.stringify(current.request.questions)).toContain(
      'different occupation',
    );
    expect(
      resolveOpportunityQuestionScreening(previous, result(previous), identity)
        .contractVersion,
    ).toBe(OPPORTUNITY_QUESTION_SCREENING_V2_VERSION);
  });
  it('combines semantic candidate witnesses without duplicates and preserves V4 replay', async () => {
    const items = await questions();
    const previous = prepare(items, 3, 0, {
      version: OPPORTUNITY_QUESTION_SCREENING_V4_VERSION,
    });
    const current = prepare(items, 3);
    expect(previous.bindings.every((binding) => !binding.candidateKeys)).toBe(
      true,
    );
    expect(JSON.stringify(previous.request.questions)).not.toContain(
      'dabbling',
    );
    expect(JSON.stringify(current.request.questions)).toContain(
      'a skill name alone does not establish depth',
    );
    expect(JSON.stringify(current.request.questions)).toContain(
      'Related or transferable technology is partial support',
    );
    expect(current.request.state).toEqual(previous.request.state);
    expect(
      resolveOpportunityQuestionScreening(previous, result(previous), identity)
        .contractVersion,
    ).toBe(OPPORTUNITY_QUESTION_SCREENING_V4_VERSION);
    const binding = current.bindings.find((binding) => binding.candidateKeys)!;
    const decision = result(current, 4);
    const keys = binding.candidateKeys!;
    select(decision, keys[0]!, 'c2');
    select(decision, keys[1]!, 'c0');
    select(decision, keys[2]!, 'c2');
    const selectedWitness = decision.answers[keys[1]!];
    if (selectedWitness?.type !== 'choice')
      throw new Error('fixture candidate choice');
    selectedWitness.confidence = 0.6;
    const answer = resolveOpportunityQuestionScreening(
      current,
      decision,
      identity,
    ).answers.find((answer) => answer.questionId === binding.questionId)!;
    expect(answer).toMatchObject({ answer: 'yes', confidence: 0.6 });
    expect(answer.candidateCitations.map((citation) => citation.id)).toEqual([
      'fact:0',
      'fact:2',
    ]);
    for (const key of keys) select(decision, key, 'none');
    expect(
      resolveOpportunityQuestionScreening(
        current,
        decision,
        identity,
      ).answers.find((answer) => answer.questionId === binding.questionId),
    ).toMatchObject({
      answer: 'unknown',
      alignment: null,
      candidateCitations: [],
    });
    select(decision, keys[2]!, 'invented');
    expect(() =>
      resolveOpportunityQuestionScreening(current, decision, identity),
    ).toThrow('offered');
  });
  it('matches individual captured skills independently with bounded witnesses and no absence claims', async () => {
    const captured = {
      ...source,
      requiredSkills: Array.from({ length: 9 }, (_, index) =>
        index === 0 ? 'Production TypeScript' : `Skill ${index}`,
      ),
      preferredSkills: 'Java, Python',
    };
    const prepared = prepare(
      await questions(),
      3,
      0,
      { version: OPPORTUNITY_QUESTION_SCREENING_V6_VERSION },
      captured,
    );
    expect(prepared.skillBindings).toHaveLength(11);
    expect(
      prepared.skillBindings!.filter((binding) => binding.scoreKey),
    ).toHaveLength(8);
    expect(prepared.skillBindings![0]!.sourceField).toBe('requiredSkills');
    const decision = result(prepared);
    const first = prepared.skillBindings![0]!;
    const score = decision.answers[first.scoreKey!];
    if (score?.type !== 'score') throw new Error('fixture skill score');
    score.confidence = 0.95;
    select(decision, first.candidateKeys![1]!, 'c1');
    const resolved = resolveOpportunityQuestionScreening(
      prepared,
      decision,
      identity,
    );
    expect(resolved.skillMatches![0]).toMatchObject({
      requirement: 'Production TypeScript',
      status: 'supported',
      assessed: true,
      sourceCitation: { sourceFieldPath: 'sourceContentJson.requiredSkills' },
    });
    expect(
      resolved.skillMatches![0]!.candidateCitations.map((cite) => cite.id),
    ).toEqual(['fact:0', 'fact:1']);
    expect(resolved.skillMatches![8]).toMatchObject({
      status: 'unknown',
      assessed: false,
      candidateCitations: [],
    });
    expect(resolved.aggregate).toEqual(
      resolveOpportunityQuestionScreening(
        prepare(await questions()),
        result(prepare(await questions())),
        identity,
      ).aggregate,
    );
    for (const key of first.candidateKeys!) select(decision, key, 'none');
    expect(
      resolveOpportunityQuestionScreening(prepared, decision, identity)
        .skillMatches![0],
    ).toMatchObject({ status: 'unknown', candidateCitations: [] });
    const previous = prepare(
      await questions(),
      3,
      0,
      { version: OPPORTUNITY_QUESTION_SCREENING_V5_VERSION },
      captured,
    );
    expect(previous.skillBindings).toBeUndefined();
    expect(
      resolveOpportunityQuestionScreening(previous, result(previous), identity)
        .skillMatches,
    ).toBeUndefined();
    expect(JSON.stringify(prepared.request.questions)).toContain(
      'Introductory exposure is not professional expertise',
    );
  });
  it('fits optional skill assessments to native bounds without dropping exact evidence', async () => {
    const captured = {
      ...source,
      requiredSkills: Array.from({ length: 8 }, (_, index) => `Skill ${index}`),
    };
    const prepared = prepare(
      [(await questions()).find((question) => question.kind === 'source')!],
      155,
      200,
      {},
      captured,
    );
    const assessed = prepared.skillBindings!.filter(
      (binding) => binding.scoreKey,
    ).length;
    expect(assessed).toBeGreaterThan(0);
    expect(assessed).toBeLessThan(8);
    expect(prepared.candidateSourceCount).toBe(155);
    expect(prepared.skillBindings).toHaveLength(8);
    expect(preflightOpportunityQuestionScreening(prepared).fits).toBe(true);
    expect(
      prepared
        .skillBindings!.slice(assessed)
        .every((binding) => !binding.scoreKey && !binding.candidateKeys),
    ).toBe(true);
  });
  it('uses bounded lossless V7 evidence bundles and selects posting requirements for fit attribution', async () => {
    const prepared = prepare(await questions(), 155, 0, {
      version: OPPORTUNITY_QUESTION_SCREENING_VERSION,
    });
    expect(Object.keys(prepared.candidateBundles!)).toHaveLength(12);
    expect(Object.keys(prepared.sourceBundles!).length).toBeLessThanOrEqual(8);
    expect(Object.values(prepared.candidateBundles!).flat()).toEqual(
      Object.keys(prepared.candidateWitnesses),
    );
    expect(Object.values(prepared.sourceBundles!).flat()).toEqual(
      Object.keys(prepared.sourceWitnesses),
    );
    const fit = prepared.bindings.find((binding) => binding.candidateKeys)!;
    expect(JSON.stringify(prepared.request.questions[fit.sourceKey])).toContain(
      'WHAT THE JOB DEMANDS',
    );
    expect(
      JSON.stringify(prepared.request.questions[fit.candidateKeys![2]!]),
    ).toContain('exposure limits');
    const decision = result(prepare(await questions(), 155));
    decision.answers = Object.fromEntries(
      Object.entries(prepared.request.questions).map(([key, question]) => {
        const existing = decision.answers[key];
        if (question.type === 'score') return [key, existing];
        if (question.type !== 'choice') throw new Error('fixture choice');
        const keys = Object.keys(question.criteria);
        const choice = keys.includes('yes')
          ? 'yes'
          : keys.find((id) => id !== 'none')!;
        return [
          key,
          {
            type: 'choice',
            choice,
            confidence: 0.2,
            probabilities: Object.fromEntries(
              keys.map((id) => [
                id,
                id === choice ? 0.9 : 0.1 / (keys.length - 1),
              ]),
            ),
          },
        ];
      }),
    );
    const resolved = resolveOpportunityQuestionScreening(
      prepared,
      decision,
      identity,
    );
    const answer = resolved.answers.find(
      (answer) => answer.questionId === fit.questionId,
    )!;
    expect(answer).toMatchObject({
      answer: 'partial',
      confidence: 0.8,
      attributionConfidence: 0.2,
    });
    expect(answer.candidateCitations.map((cite) => cite.id)).toEqual(
      Object.values(prepared.candidateWitnesses)
        .slice(0, 13)
        .map((cite) => cite.id),
    );
    expect(answer.sourceCitations).toHaveLength(
      prepared.sourceBundles!.sb0!.length,
    );
    const old = prepare(await questions(), 155, 0, {
      version: OPPORTUNITY_QUESTION_SCREENING_V6_VERSION,
    });
    expect(old.candidateBundles).toBeUndefined();
    expect(old.sourceBundles).toBeUndefined();
    expect(
      resolveOpportunityQuestionScreening(
        old,
        result(old),
        identity,
      ).answers.every((answer) => answer.attributionConfidence === undefined),
    ).toBe(true);
  });
  it('distinguishes V8 named capability evidence from V7 complete posting qualification', async () => {
    const captured = { ...source, requiredSkills: 'TypeScript, Python' };
    const current = prepare(
      await questions(),
      3,
      0,
      { version: OPPORTUNITY_QUESTION_SCREENING_VERSION },
      captured,
    );
    const previous = prepare(
      await questions(),
      3,
      0,
      { version: OPPORTUNITY_QUESTION_SCREENING_V7_VERSION },
      captured,
    );
    const key = current.skillBindings![0]!.scoreKey!;
    expect(JSON.stringify(current.request.questions[key])).toContain(
      'not suitability for the entire job',
    );
    expect(JSON.stringify(current.request.questions[key])).toContain(
      'do not import adjacent posting technologies',
    );
    expect(JSON.stringify(previous.request.questions[key])).toContain(
      'retain every linked qualifier',
    );
    expect(JSON.stringify(previous.request.questions[key])).not.toContain(
      'not suitability for the entire job',
    );
    expect(
      current.request.questions[
        current.bindings.find((binding) => binding.scoreKey)!.scoreKey!
      ],
    ).toEqual(
      previous.request.questions[
        previous.bindings.find((binding) => binding.scoreKey)!.scoreKey!
      ],
    );
    const decision = result(current);
    for (const [answerKey, question] of Object.entries(
      current.request.questions,
    )) {
      const answer = decision.answers[answerKey]!;
      if (question.type === 'choice')
        select(
          decision,
          answerKey,
          Object.keys(question.criteria).find((choice) => choice !== 'none')!,
        );
      else if (answer.type === 'score') answer.confidence = 0.95;
    }
    const resolved = resolveOpportunityQuestionScreening(
      current,
      decision,
      identity,
    );
    expect(resolved.skillMatches![0]).toMatchObject({
      meaning: 'named_capability',
      status: 'supported',
      confidence: 0.95,
    });
    expect(
      resolveOpportunityQuestionScreening(
        previous,
        {
          ...decision,
          answers: Object.fromEntries(
            Object.entries(previous.request.questions).map(
              ([key, question]) => {
                const answer = decision.answers[key]!;
                return [
                  key,
                  answer.type === 'score' && question.type === 'score'
                    ? { ...answer, levels: question.criteria }
                    : answer,
                ];
              },
            ),
          ),
        },
        identity,
      ).skillMatches!.every((match) => match.meaning === undefined),
    ).toBe(true);
  });
  it('restores compound source fields and body witnesses in catalog order without duplicate coverage', async () => {
    const question = await createScreeningQuestion({
      ...(await questions())[0]!,
      text: 'Does the posting allow remote work from Canada?',
    });
    const captured = {
      descriptionRaw: 'Build services.\nDeliver production systems.\n',
      locationNotes: 'Canada',
      workMode: 'remote',
    };
    const prepared = prepare([question], 2, 0, {}, captured);
    const keys = prepared.bindings[0]!.sourceKeys!;
    const decision = result(prepared);
    select(decision, keys[0]!, 'f1');
    select(decision, keys[1]!, 'f0');
    select(decision, keys[2]!, 'f1');
    const resolved = resolveOpportunityQuestionScreening(
      prepared,
      decision,
      identity,
    );
    expect(
      resolved.answers[0]!.sourceCitations.map((citation) => [
        citation.sourceFieldPath,
        citation.text,
      ]),
    ).toEqual([
      ['sourceContentJson.locationNotes', 'Canada'],
      ['sourceContentJson.workMode', 'remote'],
    ]);
    expect(resolved.answers[0]!.answer).toBe('yes');
    expect(resolved.aggregate.evidenceCoveragePercent).toBe(100);
    select(decision, keys[0]!, 's1');
    select(decision, keys[1]!, 's0');
    select(decision, keys[2]!, 'none');
    expect(
      resolveOpportunityQuestionScreening(
        prepared,
        decision,
        identity,
      ).answers[0]!.sourceCitations.map((citation) => citation.id),
    ).toEqual(['source:body:0', 'source:body:1']);
    select(decision, keys[2]!, 'invented');
    expect(() =>
      resolveOpportunityQuestionScreening(prepared, decision, identity),
    ).toThrow('offered');
  });
  it('returns attributable partial evidence separately from recommendation probability', async () => {
    const prepared = prepare(await questions());
    const resolved = resolveOpportunityQuestionScreening(
      prepared,
      result(prepared),
      identity,
    );
    expect(
      resolved.answers.find((item) => item.questionId === 'fit'),
    ).toMatchObject({
      answer: 'partial',
      alignment: 2,
      candidateCitations: [{ id: 'fact:0' }],
    });
    expect(resolved.aggregate.recommendationPercent).toBeCloseTo((100 * 2) / 3);
    expect(resolved.aggregate.partialQuestionIds).toEqual(['fit']);
    expect(resolved.answers[0]!.sourceCitations[0]!.text).toBe(
      prepared.sourceWitnesses.s0!.text,
    );
  });
  it('canonicalizes authentic result identity independently of caller insertion order', async () => {
    const prepared = prepare(await questions());
    const decision = result(prepared);
    const first = resolveOpportunityQuestionScreening(prepared, decision, {
      requestId: 'actual-1',
      inputFingerprint: 'input-1',
      agentRunId: 'run-1',
    });
    const second = resolveOpportunityQuestionScreening(prepared, decision, {
      agentRunId: 'run-1',
      requestId: 'actual-1',
      inputFingerprint: 'input-1',
    });
    expect(first.fingerprint).toBe(second.fingerprint);
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
  });
  it('inverts desired-no source and fit ordinal polarity', async () => {
    const items = await questions();
    const negative = await createScreeningQuestion({
      ...items[0]!,
      desiredAnswer: 'no',
    });
    const prepared = prepare([negative]);
    const decision = result(prepared);
    select(decision, prepared.bindings[0]!.answerKey!, 'no');
    expect(
      resolveOpportunityQuestionScreening(prepared, decision, identity)
        .aggregate.recommendationPercent,
    ).toBe(100);
    const fit = await createScreeningQuestion({
      ...items[1]!,
      desiredAnswer: 'no',
    });
    const fitted = prepare([fit]);
    expect(
      resolveOpportunityQuestionScreening(fitted, result(fitted, 1), identity)
        .answers[0]!.alignment,
    ).toBe(3);
  });
  it('missing attribution becomes unknown/null without inventing an opposite answer', async () => {
    const prepared = prepare(await questions());
    const decision = result(prepared);
    for (const binding of prepared.bindings)
      for (const key of binding.sourceKeys ?? [binding.sourceKey])
        select(decision, key, 'none');
    const resolved = resolveOpportunityQuestionScreening(
      prepared,
      decision,
      identity,
    );
    expect(
      resolved.answers.every(
        (item) => item.answer === 'unknown' && item.alignment === null,
      ),
    ).toBe(true);
    expect(resolved.aggregate.recommendationPercent).toBeNull();
    expect(resolved.aggregate.mustHaveConflictIds).toEqual([]);
  });
  it('rejects stale revisions/source and foreign/malformed typed output', async () => {
    const items = await questions();
    expect(() => prepare([{ ...items[0]!, text: 'changed' }])).toThrow(
      'revision',
    );
    const prepared = prepare(items);
    const decision = result(prepared);
    decision.answers.foreign = { type: 'predicate', probability: 1 };
    expect(() =>
      resolveOpportunityQuestionScreening(prepared, decision, identity),
    ).toThrow('provenance');
    const invalid = result(prepared);
    select(invalid, prepared.bindings[0]!.sourceKey, 'foreign');
    expect(() =>
      resolveOpportunityQuestionScreening(prepared, invalid, identity),
    ).toThrow('offered');
    const malformed = result(prepared);
    const score = Object.values(malformed.answers).find(
      (item) => item.type === 'score',
    );
    if (score?.type !== 'score') throw new Error('fixture score');
    score.probabilities['99'] = 0;
    expect(() =>
      resolveOpportunityQuestionScreening(prepared, malformed, identity),
    ).toThrow('distribution');
    expect(() =>
      resolveOpportunityQuestionScreening(
        prepared,
        { ...result(prepared), model: 'other' },
        identity,
      ),
    ).toThrow('provenance');
  });
  it('holds oversized full distributions without truncating source or candidate evidence', async () => {
    const fit = (await questions())[1]!;
    const many = await Promise.all(
      Array.from({ length: 5 }, (_, index) =>
        createScreeningQuestion({ ...fit, id: `fit-${index}` }),
      ),
    );
    const prepared = prepare(many, 155, 500);
    expect(preflightOpportunityQuestionScreening(prepared)).toMatchObject({
      fits: false,
    });
    expect(prepared.candidateSourceCount).toBe(155);
    expect(prepared.bindings).toHaveLength(5);
  });
  it('reserves full legal JEV distributions beyond4096 without a borrowed chat ceiling', async () => {
    const fit = (await questions())[1]!;
    const many = await Promise.all(
      Array.from({ length: 5 }, (_, index) =>
        createScreeningQuestion({ ...fit, id: `fit-${index}` }),
      ),
    );
    const prepared = prepare(many, 155);
    const preflight = preflightOpportunityQuestionScreening(prepared);
    expect(preflight.maxOutputTokens).toBeGreaterThan(4096);
    expect(preflight.fits).toBe(true);
    expect(preflight.reservedTokens).toBe(
      preflight.inputTokenCeiling + preflight.maxOutputTokens,
    );
    expect(preflight.spendMicros).toBe(1000);
  });
  it('compact catalogs restore all exact facts/titles/kinds and preserve literal user questions', async () => {
    const items = await questions();
    const question = await createScreeningQuestion({
      ...items[1]!,
      text: 'Is my candidateFacts work relevant to bodyGroups or sourceFields?',
    });
    const prepared = prepare([question], 155);
    const state = prepared.request.state;
    if (!state || typeof state !== 'object' || Array.isArray(state))
      throw new Error('fixture catalog object');
    expect(state.C).toHaveLength(155);
    expect(state.K).toEqual(['project']);
    expect(JSON.stringify(prepared.request.questions)).toContain(question.text);
    expect(prepared.candidateWitnesses.c154).toEqual({
      id: 'fact:154',
      kind: 'project',
      title: 'Project 154',
      text: 'Designed and deployed typed service 154.',
    });
  });
  it('reports an unverified vendor token context without treating bytes as the32Ktoken limit', async () => {
    const prepared = prepare([(await questions())[0]!], 155, 200);
    const preflight = preflightOpportunityQuestionScreening(prepared);
    expect(
      preflight.stateBytes + preflight.longestQuestionBytes,
    ).toBeGreaterThan(32000);
    expect(preflight).toMatchObject({
      contextEstimateUnverified: true,
      fitsConservativeModelBounds: true,
      fits: true,
    });
    expect(preflight.reservedTokens).toBeLessThanOrEqual(80000);
    const oversized = prepare([(await questions())[0]!], 155, 600);
    expect(preflightOpportunityQuestionScreening(oversized).fits).toBe(false);
    expect(
      preflightOpportunityQuestionScreening(oversized)
        .fitsConservativeModelBounds,
    ).toBe(false);
  });
  it('binds owned tuple/current questions, fresh fences and authentic governed requestID', async () => {
    const prepared = prepare([(await questions())[0]!]);
    mocks.decide.mockResolvedValue(result(prepared));
    const loadCurrent = vi.fn(async () => prepared),
      revalidateAuthority = vi.fn(async () => {});
    const resolved = await evaluateOpportunityQuestionScreening(prepared, {
      agentRunId: 'run-1',
      subject,
      loadCurrent,
      revalidateAuthority,
    });
    expect(resolved.requestId).toBe('actual-1');
    expect(loadCurrent).toHaveBeenCalledTimes(4);
    expect(
      opportunityQuestionScreeningInputFingerprint(prepared, subject),
    ).not.toBe(
      opportunityQuestionScreeningInputFingerprint(prepared, {
        ...subject,
        userId: 'foreign',
      }),
    );
    expect(mocks.governed.mock.calls[0]![0].identity).toMatchObject({
      feature: 'opportunity-question-screening',
      model: 'jev-1.13.0',
      promptVersion: prepared.version,
    });
  });
  it('rejects current-material mutation before transport and retains usage after response validation failure', async () => {
    const prepared = prepare([(await questions())[0]!]);
    const changed = prepare([
      await createScreeningQuestion({ ...prepared.questions[0]!, weight: 2 }),
    ]);
    await expect(
      evaluateOpportunityQuestionScreening(prepared, {
        agentRunId: 'run-1',
        subject,
        loadCurrent: async () => changed,
        revalidateAuthority: async () => {},
      }),
    ).rejects.toThrow('not current');
    expect(mocks.decide).not.toHaveBeenCalled();
    const malformed = { ...result(prepared), answers: {} };
    mocks.decide.mockResolvedValue(malformed);
    await expect(
      evaluateOpportunityQuestionScreening(prepared, {
        agentRunId: 'run-1',
        subject,
        loadCurrent: async () => prepared,
        revalidateAuthority: async () => {},
      }),
    ).rejects.toThrow('provenance');
    expect(mocks.attach).toHaveBeenCalledWith(expect.any(Error), {
      usage: malformed.usage,
    });
  });
});

describe('title routing and corrected size admission', () => {
  it('sends only title and current target roles, with conservative routing and no score', async () => {
    const full = prepare(await questions());
    const pre = prepareOpportunityRolePreScreen(full, {
      preferencesJson: JSON.stringify({ targetRoles: ['Software engineer'] }),
    })!;
    expect(pre.request.state).toMatchObject({
      title: source.title,
      targetRoles: ['Software engineer'],
    });
    expect(JSON.stringify(pre.request)).not.toContain(source.descriptionRaw);
    expect(JSON.stringify(pre.request)).not.toContain('Designed and deployed');
    expect(pre.bindings).toEqual([]);
    for (const [choice, confidence, expected] of [
      ['unrelated', 0.99, 'unrelated'],
      ['unrelated', 0.8, 'continue'],
      ['uncertain', 0.99, 'continue'],
      ['related', 0.99, 'continue'],
    ] as const) {
      const decision: DecisionResult = {
        model: pre.model,
        provenance: { model: pre.model, provider: 'typesafe' },
        answers: {
          role: {
            type: 'choice',
            choice,
            confidence,
            probabilities: Object.fromEntries(
              ['unrelated', 'related', 'uncertain'].map((key) => [
                key,
                key === choice ? confidence : (1 - confidence) / 2,
              ]),
            ),
          },
        },
      };
      const resolved = resolveOpportunityQuestionScreening(
        pre,
        decision,
        identity,
      );
      expect(resolved.rolePreScreen?.outcome).toBe(expected);
      expect(resolved.aggregate.recommendationPercent).toBeNull();
      expect(resolved.answers).toEqual([]);
    }
    expect(
      prepareOpportunityRolePreScreen(full, { preferencesJson: '{}' }),
    ).toBeUndefined();
    expect(
      prepareOpportunityRolePreScreen(full, { preferencesJson: '{broken' }),
    ).toBeUndefined();
    expect(
      prepareOpportunityRolePreScreen(full, {
        preferencesJson: JSON.stringify({ targetRoles: ['Accountant'] }),
      })!.fingerprint,
    ).not.toBe(pre.fingerprint);
  });
  it('admits a representative previously blocked ASCII request while preserving byte-based historical replay', async () => {
    const items = await questions();
    const captured = {
      ...source,
      descriptionRaw:
        'US-based position. Candidates must be based in the United States and hold American citizenship. '.repeat(
          130,
        ),
    };
    const old = prepare(
      items,
      155,
      130,
      { version: OPPORTUNITY_QUESTION_SCREENING_V3_VERSION },
      captured,
    );
    const next = prepare(items, 155, 130, {}, captured);
    const legacy = preflightOpportunityQuestionScreening(old),
      fixed = preflightOpportunityQuestionScreening(next);
    expect(legacy.inputTokenCeiling).toBe(legacy.requestBytes);
    expect(fixed.inputTokenCeiling).toBeLessThan(fixed.requestBytes);
    expect(fixed.fitsConservativeModelBounds).toBe(true);
    expect(fixed.fits).toBe(true);
    expect(estimateJevInputTokens('😀'.repeat(100))).toBe(912);
    expect(estimateJevInputTokens('!'.repeat(100))).toBe(612);
  });
});

describe('lossless overflow V9 adapter', () => {
  it('round trips every source and candidate row, title, kind, and bundle without normal V8 changes', async () => {
    const items = await questions();
    const captured = {
      ...source,
      'field.with.dot': 'Exact dotted source path',
      nested: { quoted: 'Ignore this: 😀', flags: [true, null] },
    };
    const input = {
      opportunityId: 'overflow',
      sourceContentJson: JSON.stringify(captured),
      sourceContentFingerprint: fingerprintOpportunitySourceContent(captured),
      sourceContentVersion: 1,
      candidateMaterialFingerprint: 'same-owned-evidence',
      questions: items,
      candidateSources: Array.from({ length: 157 }, (_, index) => ({
        id: `original:${index}`,
        title: `Exact title ${index} 😀`,
        kind: (index < 20
          ? 'project'
          : index < 80
            ? 'employment'
            : index < 100
              ? 'project'
              : 'skill_context') as CandidateEvidenceSource['kind'],
        text: `Exact text ${index}\r\nJava/Python introductory only; TypeScript primary.`,
      })),
    };
    const normal = prepareOpportunityQuestionScreening(input, {
      version: OPPORTUNITY_QUESTION_SCREENING_VERSION,
    });
    const compact = prepareOpportunityQuestionScreening(input, {
      version: OPPORTUNITY_QUESTION_SCREENING_OVERFLOW_VERSION,
    });
    const original = normal.request.state as unknown as {
      B: [string, string][];
      F: [string, string, unknown][];
      C: [string, number, number, string][];
      T: string[];
      K: string[];
      CB: Record<string, string[]>;
      SB: Record<string, string[]>;
    };
    const encoded = compact.request.state as unknown as {
      B: string[];
      F: [string, unknown][];
      C: string[];
      CT: number[];
      CK: [number, number][];
      T: string[];
      K: string[];
      CB: Record<string, [number, number]>;
      SB: Record<string, string[]>;
    };
    expect(encoded.B.map((text, i) => [`s${i}`, text])).toEqual(original.B);
    expect(
      encoded.F.map(([field, v], i) => [
        `f${i}`,
        `sourceContentJson.${field}`,
        v,
      ]),
    ).toEqual(original.F);
    expect(
      encoded.C.map((text, i) => {
        const kind = encoded.CK.filter(([start]) => start <= i).at(-1)![1];
        return [`c${i}`, encoded.CT[i], kind, text];
      }),
    ).toEqual(original.C);
    expect(encoded.T).toEqual(original.T);
    expect(encoded.K).toEqual(original.K);
    expect(encoded.SB).toEqual(original.SB);
    expect(
      Object.fromEntries(
        Object.entries(encoded.CB).map(([key, [first, last]]) => [
          key,
          [`c${first}`, `c${last}`],
        ]),
      ),
    ).toEqual(original.CB);
    expect(compact.sourceWitnesses).toEqual(normal.sourceWitnesses);
    expect(compact.candidateWitnesses).toEqual(normal.candidateWitnesses);
    expect(compact.sourceBundles).toEqual(normal.sourceBundles);
    expect(compact.candidateBundles).toEqual(normal.candidateBundles);
    expect(compact.fingerprint).not.toBe(normal.fingerprint);
    expect(
      prepareOpportunityRolePreScreen(compact, {
        preferencesJson: JSON.stringify({ targetRoles: ['Engineer'] }),
      })?.fingerprint,
    ).toBe(
      prepareOpportunityRolePreScreen(normal, {
        preferencesJson: JSON.stringify({ targetRoles: ['Engineer'] }),
      })?.fingerprint,
    );
    expect(prepareOpportunityQuestionScreening(input).fingerprint).toBe(
      normal.fingerprint,
    );
    expect(Object.keys(compact.request.questions)).toEqual(
      Object.keys(normal.request.questions),
    );
    const serialized = JSON.stringify(compact.request.questions);
    for (const policy of [
      'ALL conjuncts',
      'dabbling',
      'primary',
      'Role dates not skill tenure',
      'citizenship not authorization',
      'unknown',
    ])
      expect(serialized).toContain(policy);
  });
  it('retains optional named capability questions even when full context still exceeds the native limit', async () => {
    const captured = {
      ...source,
      requiredSkills: ['TypeScript'],
      descriptionRaw: `TypeScript required.\n${'x'.repeat(70000)}`,
    };
    const compact = prepare(
      await questions(),
      157,
      100,
      { version: OPPORTUNITY_QUESTION_SCREENING_OVERFLOW_VERSION },
      captured,
    );
    expect(compact.skillBindings?.[0]?.scoreKey).toBeTruthy();
    expect(preflightOpportunityQuestionScreening(compact).fits).toBe(false);
    expect(
      Object.values(compact.sourceWitnesses)
        .filter((row) => !row.sourceFieldPath)
        .map((row) => row.text)
        .join(''),
    ).toBe(captured.descriptionRaw);
  });
  it('preserves unknown and exact native bundle citations on compact input', async () => {
    const compact = prepare(await questions(), 20, 0, {
      version: OPPORTUNITY_QUESTION_SCREENING_OVERFLOW_VERSION,
    });
    const output = result(compact);
    const fit = compact.bindings.find((row) => row.scoreKey)!;
    for (const key of fit.candidateKeys!) select(output, key, 'cb0');
    for (const key of fit.sourceKeys!) select(output, key, 'none');
    const resolved = resolveOpportunityQuestionScreening(
      compact,
      output,
      identity,
    );
    expect(
      resolved.answers.find((row) => row.questionId === 'fit')?.answer,
    ).toBe('unknown');
    expect(
      resolved.answers.find((row) => row.questionId === 'fit')?.sourceCitations,
    ).toEqual([]);
  });
});
