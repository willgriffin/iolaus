import { createHash } from 'node:crypto';
import type { DecisionResult } from '@happyvertical/ai';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { summarizeCompleteReviewEvidence } from './opportunity-assessment-completeness.js';
import type {
  OpportunityResumeFitReviewResult,
  PreparedOpportunityResumeFitReview,
} from './opportunity-resume-fit-review.js';
import {
  assertOpportunityReviewStrengthVerificationNotAttempted,
  OPPORTUNITY_REVIEW_STRENGTH_VERIFICATION_VERSION as CURRENT_VERSION,
  evaluateOpportunityReviewStrengthVerification,
  OPPORTUNITY_REVIEW_STRENGTH_VERIFICATION_MODEL as MODEL,
  opportunityReviewStrengthVerificationInputFingerprint,
  preflightOpportunityReviewStrengthVerification,
  prepareCurrentOpportunityReviewStrengthVerification,
  prepareOpportunityReviewStrengthVerification,
  readCurrentOpportunityReviewStrengthVerification,
  readCurrentOpportunityReviewStrengthVerificationReceipt,
  resolveOpportunityReviewStrengthVerification,
  storeOpportunityReviewStrengthVerification,
  OPPORTUNITY_REVIEW_STRENGTH_VERIFICATION_V1_VERSION as VERSION,
} from './opportunity-review-strength-verification.js';

const mocks = vi.hoisted(() => ({
  savedReview: vi.fn(),
  prepareReview: vi.fn(),
  query: vi.fn(),
  list: vi.fn(),
  create: vi.fn(),
  governed: vi.fn(),
  metadata: vi.fn(),
  decide: vi.fn(),
  getAI: vi.fn(),
}));
vi.mock('@happyvertical/ai', () => ({ getAI: mocks.getAI }));
vi.mock('@happyvertical/smrt-core', () => ({
  resolveDatabase: async () => ({ query: mocks.query }),
}));
vi.mock('./db.js', () => ({ getDbConfig: () => ({}) }));
vi.mock('./opportunity-resume-fit-review.js', () => ({
  OPPORTUNITY_RESUME_FIT_REVIEW_COMPLETE_VERSION:
    'opportunity-resume-fit-review/v4-complete-material',
  readCurrentOpportunityResumeFitReview: mocks.savedReview,
  prepareCurrentOpportunityResumeFitReview: mocks.prepareReview,
}));
vi.mock('./opportunity-intelligence-governance.js', () => ({
  executeGovernedOpportunityIntelligenceRequest: mocks.governed,
  attachOpportunityIntelligenceInvocationMetadata: mocks.metadata,
}));
vi.mock('./private-workspace.js', () => ({
  requireWorkspaceSubject: (subject: typeof SUBJECT) => {
    if (!subject.tenantId || !subject.userId || !subject.profileId)
      throw new Error('owned subject required');
    return subject;
  },
  listPrivateRecords: mocks.list,
  createPrivateRecord: mocks.create,
}));
const SUBJECT = {
  tenantId: 'tenant-1',
  userId: 'owner-1',
  profileId: 'profile-1',
};
const OPPORTUNITY = { id: 'role-1' };
const V1_OPTIONS = { version: VERSION } as const;
const USAGE = { promptTokens: 2000, completionTokens: 100, totalTokens: 2100 };
function fixture() {
  const texts = [
    'Experience building REST and GraphQL APIs.',
    '3 years of React experience.',
    'Experience building enterprise financial reporting platforms.',
    'Experience using Python.',
    'Deliver a feature end to end, from design through production.',
  ];
  const facts = [
    'Built REST APIs for platform integrations.',
    '2018–2025: platform engineer. React is listed among tools without dated usage.',
    'Built an internal team scheduling application.',
    'Developed Python services and typed API tools.',
    'Designed Anytown, implemented its service and UI, deployed it, and maintained the production application.',
  ];
  let offset = 0;
  const clauses = texts.map((text, index) => {
    const start = offset;
    offset += text.length + 1;
    return {
      id: `clause:${index}`,
      key: `p${index}`,
      text,
      spanStart: start,
      spanEnd: start + text.length,
      hash: createHash('sha256').update(text).digest('hex'),
      kind: 'body' as const,
      section: 'section:opening',
    };
  });
  const candidates = facts.map((text, index) => ({
    id: `employment:${index}`,
    key: `c${index}`,
    kind: 'employment' as const,
    title: `Owned employment ${index}`,
    text,
  }));
  const requirements = clauses.map((clause, index) => ({
    key: `r${index}`,
    id: `material:${clause.id}`,
    text: clause.text,
    clauseKeys: [clause.key],
    originalRequirementIds: [`original:${index}`],
    sourceClassification: 'possible_requirement_unknown' as const,
  }));
  const reviewPrepared: PreparedOpportunityResumeFitReview = {
    version: 'opportunity-resume-fit-review/v4-complete-material',
    model: 'openai/gpt-6.1-sol',
    opportunityId: OPPORTUNITY.id,
    candidateMaterialFingerprint: 'candidate-fp',
    evidenceFingerprint: 'material-fp',
    sourceContentFingerprint: 'source-fp',
    sourceContentVersion: 1,
    messages: [],
    candidates,
    clauses,
    requirements,
    unresolvedClauseIds: clauses.map((c) => c.id),
    sourceComplete: true,
    outputShapeBytes: 1,
    maximumSerializedOutput: '{}',
    visibleOutputTokens: 2048,
    reasoningTokens: 1024,
    fingerprint: 'saved-sol-prepared',
  };
  const rows = requirements.map((row, index) => ({
    id: row.id,
    text: row.text,
    originalRequirementIds: row.originalRequirementIds,
    sourceClassification: row.sourceClassification,
    sourceDisposition: 'criterion' as const,
    status: 'strength' as const,
    seniority:
      index === 1 ? ('supported' as const) : ('not_applicable' as const),
    note: 'Original Sol interpretation.',
    candidateCitations: [
      {
        sourceId: candidates[index]!.id,
        title: candidates[index]!.title,
        kind: candidates[index]!.kind,
        start: 0,
        end: candidates[index]!.text.length,
        quote: candidates[index]!.text,
        citationMode: 'whole_fact' as const,
      },
    ],
    postingCitations: [
      {
        clauseId: clauses[index]!.id,
        start: clauses[index]!.spanStart,
        end: clauses[index]!.spanEnd,
        quote: clauses[index]!.text,
        citationMode: 'whole_clause' as const,
      },
    ],
  }));
  const evidenceFit = summarizeCompleteReviewEvidence(rows);
  const review: OpportunityResumeFitReviewResult = {
    contractVersion: reviewPrepared.version,
    mode: 'complete_material',
    requestId: 'saved-sol-request',
    agentRunId: 'saved-sol-run',
    inputFingerprint: 'saved-sol-input',
    fingerprint: reviewPrepared.fingerprint,
    candidateMaterialFingerprint: reviewPrepared.candidateMaterialFingerprint,
    evidenceFingerprint: 'material-fp',
    sourceContentFingerprint: 'source-fp',
    sourceContentVersion: 1,
    model: 'openai/gpt-6.1-sol',
    provider: 'bifrost',
    evidenceFit,
    requirements: rows,
    coverage: {
      candidateSourceCount: 5,
      reviewedRequirementIds: rows.map((r) => r.id),
      unresolvedClauseIds: clauses.map((c) => c.id),
      sourceComplete: true,
      consideredComplete: true,
      fullFit: evidenceFit,
      completion: {
        status: 'reviewed_with_unknowns',
        consideredComplete: true,
        catalogClauseCount: 5,
        reviewedMaterialClauseCount: 5,
        possibleRequirementCount: 5,
        unprocessedClauseIds: [],
        issues: [],
        evidenceFit,
      },
    },
  };
  return { reviewPrepared, review };
}
function prepared() {
  return prepareOpportunityReviewStrengthVerification(fixture(), V1_OPTIONS);
}
function decision(): DecisionResult {
  const p = prepared();
  return {
    model: MODEL,
    provenance: { provider: 'typesafe', model: MODEL },
    answers: Object.fromEntries(
      Object.keys(p.bindings).map((key) => [
        key,
        {
          type: 'predicate',
          probability:
            key.startsWith('r3_') || key.startsWith('r4_') ? 0.95 : 0.1,
        },
      ]),
    ),
  };
}
function resolve(value = decision()) {
  const p = prepared();
  return resolveOpportunityReviewStrengthVerification(
    p,
    value,
    'jev-request',
    opportunityReviewStrengthVerificationInputFingerprint(p, SUBJECT),
    'jev-run',
  );
}
function receipt() {
  const p = prepared(),
    b = preflightOpportunityReviewStrengthVerification(p);
  return {
    output_json: JSON.stringify(decision()),
    owner_request_id: 'jev-request',
    request_id: 'jev-request',
    agent_run_id: 'jev-run',
    reserved_input_tokens: b.requestBytes,
    requested_max_output_tokens: b.maxOutputTokens,
    reserved_spend_micros: b.spendMicros,
    run_status: 'succeeded',
    run_reserved_calls: 0,
    run_actual_calls: 1,
    run_call_limit: 4,
    run_reserved_tokens: 0,
    run_actual_tokens: b.reservedTokens,
    run_token_limit: 80000,
    run_reserved_spend: 0,
    run_actual_spend: b.spendMicros,
    run_spend_limit: 100000,
  };
}
beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv('OPPORTUNITY_ASSESSMENT_DECISIONS_ENABLED', 'true');
  vi.stubEnv('TYPESAFE_API_KEY', 'fixture-key');
  vi.stubEnv(
    'OPPORTUNITY_SKILL_DECISION_INPUT_COST_MICROS_PER_MILLION',
    '3000',
  );
  vi.stubEnv(
    'OPPORTUNITY_SKILL_DECISION_OUTPUT_COST_MICROS_PER_MILLION',
    '12000',
  );
  vi.stubEnv('OPPORTUNITY_INTELLIGENCE_ENABLED', 'true');
  vi.stubEnv('OPPORTUNITY_INTELLIGENCE_RUN_CALL_LIMIT', '4');
  vi.stubEnv('OPPORTUNITY_INTELLIGENCE_RUN_INPUT_TOKEN_LIMIT', '80000');
  vi.stubEnv('OPPORTUNITY_INTELLIGENCE_RUN_SPEND_LIMIT_MICROS', '100000');
  const f = fixture();
  mocks.savedReview.mockResolvedValue(f.review);
  mocks.prepareReview.mockResolvedValue(f.reviewPrepared);
  mocks.query.mockResolvedValue({ rows: [] });
  mocks.list.mockResolvedValue([]);
  mocks.decide.mockResolvedValue({ ...decision(), usage: USAGE });
  mocks.getAI.mockResolvedValue({
    getCapabilities: async () => ({ decisions: true }),
    decide: mocks.decide,
  });
  mocks.metadata.mockImplementation((error) => error);
  mocks.governed.mockImplementation(async (options) => {
    const result = await options.invoke('jev-request');
    return { ...result, requestId: 'jev-request' };
  });
});
describe('independent saved Sol strength verification', () => {
  it('retains exact V1 dimensions/replay while V2 presents lossless cited-only dictionaries', () => {
    const legacy = prepared();
    const next = prepareOpportunityReviewStrengthVerification(fixture());
    expect(legacy.version).toBe(VERSION);
    expect(legacy.request.state).toEqual({});
    expect(Object.keys(legacy.bindings)).toHaveLength(6);
    expect(next.version).toBe(CURRENT_VERSION);
    expect(Object.keys(next.bindings)).toHaveLength(11);
    const state = next.request.state as {
      sourceClauses: Record<string, { text: string }>;
      candidateFacts: Record<string, { text: string }>;
      policies: Record<string, string>;
    };
    expect(Object.values(state.sourceClauses).map((row) => row.text)).toEqual(
      fixture().review.requirements.map(
        (row) => row.postingCitations[0]!.quote,
      ),
    );
    expect(Object.values(state.candidateFacts).map((row) => row.text)).toEqual(
      fixture().review.requirements.map(
        (row) => row.candidateCitations[0]!.quote,
      ),
    );
    expect(state.policies.strict).toContain('(ALL)');
    expect(state.policies.strict).toContain('(ANY)');
    expect(state.policies.partial_relevance).toContain(
      'A directly demonstrated component may be relevant while another conjunct, level, or threshold remains unproven.',
    );
    expect(state.policies.partial_relevance).not.toMatch(
      /REST|GraphQL|React|Python/,
    );
    expect(state.policies.partial_relevance).toContain('domain-specific');
    expect(
      String(next.request.questions.r0_partial_relevance!.instructions),
    ).toContain('state.candidateFacts.c0');
    expect(
      String(next.request.questions.r0_partial_relevance!.instructions),
    ).not.toContain('Built REST APIs');
    expect(
      preflightOpportunityReviewStrengthVerification(next).requestBytes,
    ).toBeLessThanOrEqual(32768);
    const { fingerprint: _legacyFP, ...legacyMaterial } = legacy;
    const legacyDimensions = Object.fromEntries(
      Object.entries(next.bindings).filter(
        ([, row]) => row.dimension !== 'partial_relevance',
      ),
    );
    expect(legacy.fingerprint).toBe(
      createHash('sha256')
        .update(
          JSON.stringify({ ...legacyMaterial, bindings: legacyDimensions }),
        )
        .digest('hex'),
    );
    expect(resolve().verification).not.toHaveProperty('partialClaimCount');
  });
  it('reports REST/React/Python component support separately, rejects domain overclaim, and excludes fully strict rows from partial counts', () => {
    const next = prepareOpportunityReviewStrengthVerification(fixture());
    const value: DecisionResult = {
      model: MODEL,
      provenance: { provider: 'typesafe', model: MODEL },
      answers: Object.fromEntries(
        Object.keys(next.bindings).map((key) => [
          key,
          { type: 'predicate', probability: 0.1 },
        ]),
      ),
    };
    for (const key of [
      'r0_partial_relevance',
      'r1_partial_relevance',
      'r3_partial_relevance',
      'r4_partial_relevance',
      'r4_strength',
    ])
      value.answers[key] = { type: 'predicate', probability: 0.95 };
    const result = resolveOpportunityReviewStrengthVerification(
      next,
      value,
      'v2-request',
      opportunityReviewStrengthVerificationInputFingerprint(next, SUBJECT),
      'v2-run',
    );
    expect(result.verification.partialClaimCount).toBe(5);
    expect(result.verification.verifiedPartialCount).toBe(3);
    expect(result.verification.partialSupportedRequirementIds).toEqual([
      next.originalReview.requirements[0]!.id,
      next.originalReview.requirements[1]!.id,
      next.originalReview.requirements[3]!.id,
    ]);
    expect(result.requirements.map((row) => row.status)).toEqual([
      'uncertain',
      'uncertain',
      'uncertain',
      'uncertain',
      'strength',
    ]);
    expect(result.requirements[1]!.seniority).toBe('uncertain');
    expect(result.evidenceFit.supportedCriterionCount).toBe(1);
    expect(result.effectiveReview.coverage.fullFit).toEqual(result.evidenceFit);
    expect(result.originalReview).toEqual(fixture().review);
    value.answers.r0_partial_relevance = {
      type: 'predicate',
      probability: 0.84999,
    };
    expect(
      resolveOpportunityReviewStrengthVerification(
        next,
        value,
        'id',
        'input',
        'run',
      ).verification.verifiedPartialCount,
    ).toBe(2);
    value.answers.r0_partial_relevance = {
      type: 'predicate',
      probability: 0.85,
    };
    expect(
      resolveOpportunityReviewStrengthVerification(
        next,
        value,
        'id',
        'input',
        'run',
      ).verification.verifiedPartialCount,
    ).toBe(3);
  });
  it('offers partial relevance for uncertain interpreted criteria with cited facts without changing strict support', () => {
    const input = fixture();
    input.review.requirements[0]!.status = 'uncertain';
    const next = prepareOpportunityReviewStrengthVerification(input);
    expect(next.bindings.r0_strength).toBeUndefined();
    expect(next.bindings.r0_partial_relevance?.dimension).toBe(
      'partial_relevance',
    );
    const value: DecisionResult = {
      model: MODEL,
      provenance: { provider: 'typesafe', model: MODEL },
      answers: Object.fromEntries(
        Object.keys(next.bindings).map((key) => [
          key,
          {
            type: 'predicate',
            probability: key === 'r0_partial_relevance' ? 0.95 : 0.1,
          },
        ]),
      ),
    };
    const result = resolveOpportunityReviewStrengthVerification(
      next,
      value,
      'id',
      'input',
      'run',
    );
    expect(result.verification.verifiedPartialCount).toBe(1);
    expect(result.verification.verifiedStrengthCount).toBe(0);
    expect(result.requirements[0]!.status).toBe('uncertain');
    expect(result.evidenceFit.supportedCriterionCount).toBe(0);
  });
  it('holds oversized V2 dictionaries without clipping any exact source or cited fact', () => {
    const input = fixture();
    const text = 'Exact retained factual context. '.repeat(2000);
    input.reviewPrepared.candidates[0]!.text = text;
    Object.assign(input.review.requirements[0]!.candidateCitations[0]!, {
      quote: text,
      end: text.length,
    });
    const next = prepareOpportunityReviewStrengthVerification(input);
    expect(
      preflightOpportunityReviewStrengthVerification(next).requestBytes,
    ).toBeGreaterThan(32768);
    expect(preflightOpportunityReviewStrengthVerification(next).fits).toBe(
      false,
    );
    expect(JSON.stringify(next.request.state)).toContain(text);
  });
  it('offers one binary per asserted strength/tenure, literal cited facts only, and preserves conjunction/alternative/skill-duration semantics', () => {
    const p = prepared();
    expect(Object.keys(p.request.questions)).toHaveLength(6);
    expect(p.request.state).toEqual({});
    expect(Object.keys(p.bindings)).toEqual([
      'r0_strength',
      'r1_strength',
      'r1_seniority',
      'r2_strength',
      'r3_strength',
      'r4_strength',
    ]);
    const strength = String(p.request.questions.r0_strength!.instructions);
    expect(strength).toContain('REST and GraphQL');
    expect(strength).toContain('Built REST APIs');
    expect(strength).not.toContain('Anytown');
    expect(strength).toContain('(ALL)');
    expect(strength).toContain('(ANY)');
    expect(strength).toContain('Semantic equivalents');
    expect(String(p.request.questions.r1_seniority!.instructions)).toContain(
      'dates must explicitly link',
    );
  });
  it('downgrades missing GraphQL, undated React tenure and domain overclaim while retaining Python and end-to-end support', () => {
    const result = resolve();
    expect(result.requirements.map((r) => r.status)).toEqual([
      'uncertain',
      'uncertain',
      'uncertain',
      'strength',
      'strength',
    ]);
    expect(result.requirements[1]!.seniority).toBe('uncertain');
    expect(result.verification).toMatchObject({
      strengthClaimCount: 5,
      verifiedStrengthCount: 2,
      seniorityClaimCount: 1,
      verifiedSeniorityCount: 0,
    });
    expect(result.originalReview).toEqual(fixture().review);
    expect(result.effectiveReview.requirements).toEqual(result.requirements);
    expect(result.effectiveReview.coverage.fullFit).toEqual(result.evidenceFit);
    expect(result.effectiveReview.coverage.completion?.evidenceFit).toEqual(
      result.evidenceFit,
    );
    expect(result.requirements[0]!.candidateCitations).toEqual(
      result.originalReview.requirements[0]!.candidateCitations,
    );
  });
  it('requires inclusive .85 independently for strength and supported tenure', () => {
    const value = decision();
    value.answers.r1_strength = { type: 'predicate', probability: 0.85 };
    value.answers.r1_seniority = { type: 'predicate', probability: 0.84999 };
    const result = resolve(value);
    expect(result.requirements[1]!.status).toBe('uncertain');
    expect(result.requirements[1]!.seniority).toBe('uncertain');
    value.answers.r1_seniority = { type: 'predicate', probability: 0.85 };
    expect(resolve(value).requirements[1]!.seniority).toBe('supported');
    expect(resolve(value).requirements[1]!.status).toBe('strength');
  });
  it('keeps raw positive strength but downgrades effective support when asserted tenure fails', () => {
    const value = decision();
    for (const key of Object.keys(value.answers))
      value.answers[key] = { type: 'predicate', probability: 0.1 };
    value.answers.r1_strength = { type: 'predicate', probability: 0.95 };
    value.answers.r1_seniority = { type: 'predicate', probability: 0.4 };
    const result = resolve(value);
    expect(result.requirements[1]).toMatchObject({
      status: 'uncertain',
      seniority: 'uncertain',
    });
    expect(result.answerProbabilities.r1_strength).toBe(0.95);
    expect(
      result.judgments.find(
        (row) =>
          row.requirementId === result.requirements[1]!.id &&
          row.dimension === 'strength',
      ),
    ).toMatchObject({ verified: true, probability: 0.95 });
    expect(result.verification.verifiedStrengthCount).toBe(0);
    expect(result.evidenceFit.supportedCriterionCount).toBe(0);
    expect(result.effectiveReview.coverage.fullFit).toEqual(result.evidenceFit);
    expect(result.originalReview.requirements[1]).toMatchObject({
      status: 'strength',
      seniority: 'supported',
    });
  });
  it.each([
    'missing',
    'extra',
    'nonfinite',
    'foreign_model',
    'missing_provenance',
  ])('rejects %s typed output without exposing private values', (kind) => {
    const value = decision();
    if (kind === 'missing') delete value.answers.r0_strength;
    if (kind === 'extra')
      value.answers.foreign = { type: 'predicate', probability: 0.99 };
    if (kind === 'nonfinite')
      value.answers.r0_strength = { type: 'predicate', probability: NaN };
    if (kind === 'foreign_model') value.model = 'foreign';
    if (kind === 'missing_provenance')
      Reflect.deleteProperty(value, 'provenance');
    expect(() => resolve(value)).toThrow('invalid');
  });
  it.each([
    'candidate_quote',
    'posting_span',
    'foreign_source',
    'raw_only',
    'material_mutation',
  ])('rejects %s prepared source/citation drift', (kind) => {
    const input = fixture();
    if (kind === 'candidate_quote')
      input.review.requirements[0]!.candidateCitations[0]!.quote =
        'INVENTED PRIVATE MARKER';
    if (kind === 'posting_span')
      input.review.requirements[0]!.postingCitations[0]!.start++;
    if (kind === 'foreign_source')
      input.review.sourceContentFingerprint = 'foreign';
    if (kind === 'raw_only') input.review.coverage.completion = undefined;
    if (kind === 'material_mutation') {
      const p = prepared();
      p.request.questions.r0_strength!.instructions = 'changed';
      expect(() =>
        resolveOpportunityReviewStrengthVerification(
          p,
          decision(),
          'id',
          'input',
          'run',
        ),
      ).toThrow('invalid');
    } else
      expect(() =>
        prepareOpportunityReviewStrengthVerification(input, V1_OPTIONS),
      ).toThrow('invalid');
  });
  it('binds complete saved original result, exact principal/model and real conservative input/output accounting', () => {
    const p = prepared();
    const b = preflightOpportunityReviewStrengthVerification(p);
    expect(b.reservedTokens).toBe(b.requestBytes + b.maxOutputTokens);
    expect(b.fits).toBe(true);
    expect(b.calls).toBe(1);
    expect(
      opportunityReviewStrengthVerificationInputFingerprint(p, SUBJECT),
    ).not.toBe(
      opportunityReviewStrengthVerificationInputFingerprint(p, {
        ...SUBJECT,
        profileId: 'other',
      }),
    );
    expect(p.originalReview.requestId).toBe('saved-sol-request');
  });
  it('requires current SAVED Sol review and prevents prior exact failed identities from another governed attempt', async () => {
    mocks.savedReview.mockResolvedValueOnce(undefined);
    await expect(
      prepareCurrentOpportunityReviewStrengthVerification(OPPORTUNITY, SUBJECT),
    ).rejects.toThrow('saved actual Sol');
    mocks.query.mockResolvedValue({ rows: [{ request_id: 'prior-failed' }] });
    await expect(
      assertOpportunityReviewStrengthVerificationNotAttempted(
        prepared(),
        SUBJECT,
      ),
    ).rejects.toThrow('already been attempted');
    expect(mocks.decide).not.toHaveBeenCalled();
  });
  it('uses authentic governed request ID and attaches actual returned usage on typed validation failure', async () => {
    const p = prepared();
    const fence = vi.fn(async () => {});
    const result = await evaluateOpportunityReviewStrengthVerification(p, {
      opportunity: OPPORTUNITY,
      subject: SUBJECT,
      agentRunId: 'jev-run',
      revalidateMaterial: fence,
    });
    expect(result.requestId).toBe('jev-request');
    expect(fence.mock.calls.length).toBeGreaterThanOrEqual(4);
    expect(mocks.governed).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceSubject: SUBJECT,
        identity: expect.objectContaining({
          model: MODEL,
          promptVersion: VERSION,
        }),
      }),
    );
    mocks.decide.mockResolvedValue({
      ...decision(),
      answers: {},
      usage: USAGE,
    });
    await expect(
      evaluateOpportunityReviewStrengthVerification(p, {
        opportunity: OPPORTUNITY,
        subject: SUBJECT,
        agentRunId: 'jev-run',
        revalidateMaterial: fence,
      }),
    ).rejects.toThrow('invalid');
    expect(mocks.metadata).toHaveBeenLastCalledWith(expect.any(Error), {
      usage: USAGE,
    });
  });
  it('rejects fresh material change immediately before transport and after actual response', async () => {
    const p = prepared();
    let fences = 0;
    const before = async () => {
      if (++fences === 2)
        mocks.savedReview.mockResolvedValue({
          ...fixture().review,
          requestId: 'changed',
        });
    };
    await expect(
      evaluateOpportunityReviewStrengthVerification(p, {
        opportunity: OPPORTUNITY,
        subject: SUBJECT,
        agentRunId: 'jev-run',
        revalidateMaterial: before,
      }),
    ).rejects.toThrow('not current');
    expect(mocks.decide).not.toHaveBeenCalled();
    mocks.savedReview.mockResolvedValue(fixture().review);
    fences = 0;
    const after = async () => {
      if (++fences === 3)
        mocks.savedReview.mockResolvedValue({
          ...fixture().review,
          requestId: 'changed',
        });
    };
    await expect(
      evaluateOpportunityReviewStrengthVerification(p, {
        opportunity: OPPORTUNITY,
        subject: SUBJECT,
        agentRunId: 'jev-run',
        revalidateMaterial: after,
      }),
    ).rejects.toThrow('not current');
    expect(mocks.metadata).toHaveBeenLastCalledWith(expect.any(Error), {
      usage: USAGE,
    });
  });
  it('reconstructs only an actual joined PRIVATE receipt with current source/profile/run accounting', async () => {
    mocks.query.mockResolvedValue({ rows: [receipt()] });
    expect(
      (
        await readCurrentOpportunityReviewStrengthVerificationReceipt(
          OPPORTUNITY,
          SUBJECT,
          V1_OPTIONS,
        )
      )?.verification.verifiedStrengthCount,
    ).toBe(2);
    const sql = mocks.query.mock.calls[0]![0];
    expect(sql).toContain("q.accounting_basis='actual'");
    expect(sql).toContain('q.actual_total_tokens>0');
    expect(sql).toContain('r.tenant_id=q.tenant_id');
    expect(sql).not.toContain('q.prompt_version');
    for (const field of [
      'reserved_input_tokens',
      'requested_max_output_tokens',
      'reserved_spend_micros',
      'run_token_limit',
    ] as const) {
      mocks.query.mockResolvedValue({ rows: [{ ...receipt(), [field]: 0 }] });
      expect(
        await readCurrentOpportunityReviewStrengthVerificationReceipt(
          OPPORTUNITY,
          SUBJECT,
          V1_OPTIONS,
        ),
      ).toBeUndefined();
    }
    mocks.query.mockResolvedValue({ rows: [receipt(), receipt()] });
    expect(
      await readCurrentOpportunityReviewStrengthVerificationReceipt(
        OPPORTUNITY,
        SUBJECT,
        V1_OPTIONS,
      ),
    ).toBeUndefined();
  });
  it('publishes a separate attested overlay, never raw provider-only output or modified Sol assessment', async () => {
    const p = prepared(),
      result = resolve();
    mocks.query.mockResolvedValue({ rows: [receipt()] });
    expect(
      await readCurrentOpportunityReviewStrengthVerification(
        OPPORTUNITY,
        SUBJECT,
        V1_OPTIONS,
      ),
    ).toBeUndefined();
    expect(
      await storeOpportunityReviewStrengthVerification({
        prepared: p,
        result,
        opportunity: OPPORTUNITY,
        subject: SUBJECT,
        agentRunId: 'jev-run',
      }),
    ).toBe(true);
    const saved = mocks.create.mock.calls[0]![2];
    expect(saved.contractVersion).toBe(VERSION);
    expect(saved.status).toBe('strength_verified');
    expect(JSON.parse(saved.assessmentJson).originalReview).toEqual(
      fixture().review,
    );
    mocks.list.mockResolvedValue([saved]);
    expect(
      await readCurrentOpportunityReviewStrengthVerification(
        OPPORTUNITY,
        SUBJECT,
        V1_OPTIONS,
      ),
    ).toEqual(result);
    await expect(
      storeOpportunityReviewStrengthVerification({
        prepared: p,
        result: { ...result, requestId: 'invented' },
        opportunity: OPPORTUNITY,
        subject: SUBJECT,
        agentRunId: 'jev-run',
      }),
    ).rejects.toThrow('actual PRIVATE');
  });
});
