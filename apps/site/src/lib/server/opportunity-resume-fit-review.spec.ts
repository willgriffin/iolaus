import { createHash } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { buildRequirementCoverageSource } from './opportunity-requirement-coverage.js';
import type { PartialOpportunityRequirementEvidence } from './opportunity-requirement-coverage-provider.js';
import {
  assertOpportunityResumeFitReviewNotAttempted,
  evaluateOpportunityResumeFitReview,
  OPPORTUNITY_RESUME_FIT_REVIEW_MODEL,
  OPPORTUNITY_RESUME_FIT_REVIEW_QUOTE_VERSION,
  OPPORTUNITY_RESUME_FIT_REVIEW_VERSION,
  opportunityResumeFitReviewInputFingerprint,
  preflightOpportunityResumeFitReview,
  prepareCurrentOpportunityResumeFitReview,
  prepareOpportunityResumeFitReview,
  readCurrentOpportunityResumeFitReview,
  readCurrentOpportunityResumeFitReviewReceipt,
  resolveOpportunityResumeFitReview,
  storeOpportunityResumeFitReview,
} from './opportunity-resume-fit-review.js';
import type { CandidateEvidenceSource } from './resume-data.js';

const mocks = vi.hoisted(() => ({
  readSource: vi.fn(),
  loadCandidate: vi.fn(),
  getProfile: vi.fn(),
  query: vi.fn(),
  list: vi.fn(),
  create: vi.fn(),
  governed: vi.fn(),
  metadata: vi.fn(),
  chat: vi.fn(),
  countTokens: vi.fn(),
  clientModel: vi.fn(),
}));
vi.mock('@happyvertical/smrt-core', () => ({
  resolveDatabase: async () => ({ query: mocks.query }),
}));
vi.mock('./smrt.js', () => ({
  getCollection: async () => ({ get: mocks.getProfile }),
}));
vi.mock('./db.js', () => ({ getDbConfig: () => ({}) }));
vi.mock('./opportunity-requirement-coverage-provider.js', () => ({
  readPartialOpportunityRequirementEvidence: mocks.readSource,
}));
vi.mock('./resume-data.js', () => ({
  loadWorkspaceCandidateEvidence: mocks.loadCandidate,
}));
vi.mock('./private-workspace.js', () => ({
  requireWorkspaceSubject: (subject: typeof SUBJECT) => {
    if (!subject?.tenantId || !subject.userId || !subject.profileId)
      throw new Error('Missing owned subject.');
    return subject;
  },
  listPrivateRecords: mocks.list,
  createPrivateRecord: mocks.create,
}));
vi.mock('./opportunity-intelligence-governance.js', () => ({
  executeGovernedOpportunityIntelligenceRequest: mocks.governed,
  attachOpportunityIntelligenceInvocationMetadata: mocks.metadata,
}));
vi.mock('./ai-config.js', () => ({
  AI_PROFILE_CHAT_MAX_OUTPUT_TOKENS: 4096,
  resolveOpportunityResumeFitReviewModel: (model?: string) => {
    const selected =
      model ??
      (process.env.BIFROST_OPPORTUNITY_INTELLIGENCE_SCORING_MODEL ||
        'openai/gpt-6.1-sol');
    if (!['openai/gpt-6-luna', 'openai/gpt-6.1-sol'].includes(selected))
      throw new Error('exact registered');
    return selected;
  },
  resolveOpportunityResumeFitReviewAiProfileClient: async (options: {
    model: string;
  }) => ({
    model: mocks.clientModel() ?? options.model,
    timeout: 30000,
    aiClient: { chat: mocks.chat, countTokens: mocks.countTokens },
  }),
}));

const SUBJECT = {
  tenantId: 'tenant-1',
  userId: 'owner-1',
  profileId: 'profile-1',
};
const OPPORTUNITY = { id: 'role-1' };
const PROFILE = {
  id: 'profile-1',
  tenantId: 'tenant-1',
  ownerUserId: 'owner-1',
  active: true,
  name: 'Engineer',
  title: 'Platform engineer',
  summary: 'Owned Kubernetes services.',
  factsJson: '',
};
const USAGE = { promptTokens: 4000, completionTokens: 200, totalTokens: 4200 };

function fixture(count = 150) {
  const context = {
    sourceText:
      'Requirements\nFamiliarity with Kubernetes.\nCompany context remains unresolved.',
    sourceFingerprint: 'source-1',
    sourceVersion: 1,
    extractionFingerprint: 'extract-1',
  };
  const ledger = buildRequirementCoverageSource(context);
  const criterionClause = ledger.clauses[1];
  const unresolvedClause = ledger.clauses[2];
  if (!criterionClause || !unresolvedClause)
    throw new Error('Invalid test source.');
  const requirement = {
    id: 'k8',
    text: 'Familiarity with Kubernetes.',
    clauseIds: [criterionClause.id],
    importance: 'unknown' as const,
  };
  ledger.requirements = [requirement];
  ledger.dispositions = ledger.clauses.map((clause, index) =>
    index === 0
      ? {
          clauseId: clause.id,
          type: 'nonrequirement',
          requirementIds: [],
          exclusionRule: 'section_heading',
        }
      : index === 1
        ? {
            clauseId: clause.id,
            type: 'material_requirement',
            requirementIds: ['k8'],
          }
        : { clauseId: clause.id, type: 'source_context', requirementIds: [] },
  );
  const source: PartialOpportunityRequirementEvidence = {
    mode: 'partial',
    context,
    ledger,
    fingerprint: 'actual-global-source-evidence',
    acceptedRequirements: [requirement],
    unresolvedClauses: [{ ...unresolvedClause, reason: 'context' }],
    capturedSource: {
      extractionRequestId: 'actual-extract',
      sourceContentJson: JSON.stringify({
        descriptionRaw: context.sourceText,
        locationNotes: 'Canada (Remote)',
        workMode: 'remote',
      }),
    },
    audit: {
      version: 'requirement-evidence-audit/v4-captured-source-recovery',
      ledgerFingerprint: 'ledger-fp',
      inputFingerprint: 'audit-input',
      requestId: 'actual-global-source',
      answerProbabilities: {},
      rowSupport: { k8: 0.98 },
      rowRelevance: { k8: 0.95 },
      clausePrecision: {},
      clauseRecall: {},
      clauseContext: {},
      acceptedRequirementIds: ['k8'],
      unresolvedClauseIds: [unresolvedClause.id],
      fullCoverage: false,
      fingerprint: 'audit-fp',
    },
  };
  const candidateSources: CandidateEvidenceSource[] = Array.from(
    { length: count },
    (_, index) => ({
      id: `employment:${index}`,
      kind: 'employment',
      recordId: `record-${index}`,
      title: `Employment ${index}`,
      text: `Owned Kubernetes production services during role ${index}.`,
    }),
  );
  candidateSources[0] = {
    id: 'profile:profile-1',
    kind: 'candidate_profile',
    title: PROFILE.name,
    text: `${PROFILE.title}\n${PROFILE.summary}`,
  };
  return { source, candidateSources };
}
function output(
  prepared: ReturnType<typeof prepareOpportunityResumeFitReview>,
) {
  return {
    requirements: prepared.requirements.map((criterion) => {
      const posting = prepared.clauses.find(
        (clause) => clause.key === criterion.clauseKeys[0],
      );
      const candidate = prepared.candidates.at(-1);
      if (!posting || !candidate) throw new Error('Missing fixture citation.');
      return {
        id: criterion.key,
        status: 'strength',
        seniority: 'not_applicable',
        note: 'Attributed Kubernetes production experience.',
        candidate: [
          { id: candidate.key, start: 0, end: candidate.text.length },
        ],
        posting: [{ id: posting.key, start: 0, end: posting.text.length }],
      };
    }),
  };
}
function quoteOutput(
  prepared: ReturnType<typeof prepareOpportunityResumeFitReview>,
) {
  return {
    requirements: prepared.requirements.map((criterion) => {
      const candidate = prepared.candidates.at(-1)!;
      const posting = prepared.clauses.find(
        (clause) => clause.key === criterion.clauseKeys[0],
      )!;
      return {
        id: criterion.key,
        status: 'strength',
        seniority: 'not_applicable',
        note: 'Explicit attributed source evidence.',
        candidate: [{ id: candidate.key, quote: candidate.text.slice(0, 128) }],
        posting: [{ id: posting.key, quote: posting.text.slice(0, 128) }],
      };
    }),
  };
}
function resolve(
  prepared: ReturnType<typeof prepareOpportunityResumeFitReview>,
  value: unknown = output(prepared),
) {
  return resolveOpportunityResumeFitReview(
    prepared,
    value,
    'governed-1',
    opportunityResumeFitReviewInputFingerprint(prepared, SUBJECT),
    'run-1',
  );
}
async function current() {
  return await prepareCurrentOpportunityResumeFitReview(OPPORTUNITY, SUBJECT);
}
async function receipt(
  prepared: ReturnType<typeof prepareOpportunityResumeFitReview>,
) {
  const reservation = await preflightOpportunityResumeFitReview(prepared);
  return {
    output_json: JSON.stringify(output(prepared)),
    owner_request_id: 'governed-1',
    request_id: 'governed-1',
    agent_run_id: 'run-1',
    reserved_input_tokens: reservation.inputTokenCeiling,
    requested_max_output_tokens: reservation.maxOutputTokens,
    reserved_spend_micros: reservation.reservedSpendMicros,
    run_status: 'succeeded',
    run_reserved_calls: 0,
    run_actual_calls: 1,
    run_call_limit: 4,
    run_reserved_tokens: 0,
    run_actual_tokens: reservation.reservedTokens,
    run_token_limit: 80000,
    run_reserved_spend: 0,
    run_actual_spend: reservation.reservedSpendMicros,
    run_spend_limit: 100000,
  };
}
beforeEach(() => {
  vi.unstubAllEnvs();
  vi.stubEnv('BIFROST_OPPORTUNITY_INTELLIGENCE_SCORING_MODEL', '');
  vi.clearAllMocks();
  mocks.clientModel.mockReset();
  for (const [key, value] of Object.entries({
    OPPORTUNITY_INTELLIGENCE_ENABLED: 'true',
    OPPORTUNITY_INTELLIGENCE_RUN_CALL_LIMIT: '4',
    OPPORTUNITY_INTELLIGENCE_RUN_INPUT_TOKEN_LIMIT: '80000',
    OPPORTUNITY_INTELLIGENCE_RUN_SPEND_LIMIT_MICROS: '100000',
  }))
    vi.stubEnv(key, value);
  const { source, candidateSources } = fixture();
  mocks.readSource.mockResolvedValue(source);
  mocks.loadCandidate.mockResolvedValue({
    fingerprint: 'complete-candidate-catalog',
    evidence: candidateSources,
  });
  mocks.getProfile.mockResolvedValue({
    id: PROFILE.id,
    toJSON: () => ({ ...PROFILE }),
  });
  mocks.query.mockResolvedValue({ rows: [] });
  mocks.list.mockResolvedValue([]);
  mocks.create.mockResolvedValue({});
  mocks.countTokens.mockImplementation(async (text: string) =>
    text.startsWith('{"requirements":') ? 1000 : 4000,
  );
  mocks.metadata.mockImplementation((cause) => cause);
  mocks.governed.mockImplementation(async (options) => ({
    ...(await options.invoke('governed-1')),
    requestId: 'governed-1',
    reused: false,
  }));
});

describe('bounded complete-catalog Sol advisory review', () => {
  it('retains all 150 sources including the tail, full raw/ATS and unresolved coverage', () => {
    const fixtureValue = fixture();
    const prepared = prepareOpportunityResumeFitReview({
      opportunityId: 'role-1',
      ...fixtureValue,
      candidateMaterialFingerprint: 'candidate-1',
    });
    expect(prepared.candidates).toHaveLength(150);
    expect(prepared.candidates.at(-1)?.id).toBe('employment:149');
    const payload = JSON.parse(String(prepared.messages[1]?.content));
    expect(payload.source.body).toBe(fixtureValue.source.context.sourceText);
    expect(payload.source.capturedSource).toContain('Canada (Remote)');
    expect(payload.candidateCatalog).toHaveLength(150);
    const result = resolve(prepared);
    expect(result.coverage.reviewedRequirementIds).toEqual(['k8']);
    expect(result.coverage.unresolvedClauseIds).toEqual(
      prepared.unresolvedClauseIds,
    );
    expect(result.coverage.fullFit).toBe('unknown');
    expect(result.requirements[0]?.candidateCitations[0]?.sourceId).toBe(
      'employment:149',
    );
    expect(result.requirements[0]?.postingCitations[0]?.quote).toBe(
      'Familiarity with Kubernetes.',
    );
    expect(result).not.toHaveProperty('fitScore');
    expect(result).not.toHaveProperty('eligibility');
  });
  it('binds candidate/source edits and owned tuple changes into different identities', () => {
    const value = fixture();
    const prepared = prepareOpportunityResumeFitReview({
      opportunityId: 'role-1',
      ...value,
      candidateMaterialFingerprint: 'candidate-1',
    });
    value.candidateSources[149] = {
      ...value.candidateSources[149],
      id: 'employment:149',
      kind: 'employment',
      title: 'Employment 149',
      text: 'Changed exact native evidence.',
    };
    const changed = prepareOpportunityResumeFitReview({
      opportunityId: 'role-1',
      ...value,
      candidateMaterialFingerprint: 'candidate-2',
    });
    expect(changed.fingerprint).not.toBe(prepared.fingerprint);
    expect(
      opportunityResumeFitReviewInputFingerprint(prepared, {
        ...SUBJECT,
        profileId: 'other',
      }),
    ).not.toBe(opportunityResumeFitReviewInputFingerprint(prepared, SUBJECT));
  });
  it('reserves visible3500 plus reasoning1024 and native-counts the complete output envelope', async () => {
    const prepared = await current();
    const fallback = await preflightOpportunityResumeFitReview(prepared);
    const measured = await preflightOpportunityResumeFitReview(
      prepared,
      async (text) =>
        text === prepared.maximumSerializedOutput
          ? 1000
          : fallback.inputTokenCount + 13,
    );
    expect(measured.inputTokenCeiling).toBe(fallback.inputTokenCount + 13);
    expect(measured.inputTokenCeiling).toBeLessThan(measured.requestBytes);
    expect(measured.maxOutputTokens).toBe(4524);
    expect(measured.visibleOutputTokens).toBe(3500);
    expect(measured.reasoningTokens).toBe(1024);
    expect(measured.reservedTokens).toBe(measured.inputTokenCeiling + 4524);
    expect(measured.reservedSpendMicros).toBe(
      Math.ceil(
        (measured.inputTokenCeiling * 2000000 + 4524 * 10000000) / 1000000,
      ),
    );
    expect(measured.fits).toBe(true);
  });
  it('holds oversized full catalogs/output without clipping any source', async () => {
    const value = fixture();
    value.candidateSources[149] = {
      id: 'employment:149',
      kind: 'employment',
      title: 'Full record',
      text: 'x'.repeat(200000),
    };
    const prepared = prepareOpportunityResumeFitReview({
      opportunityId: 'role-1',
      ...value,
      candidateMaterialFingerprint: 'candidate-large',
    });
    expect(prepared.candidates[149]?.text).toHaveLength(200000);
    expect((await preflightOpportunityResumeFitReview(prepared)).fits).toBe(
      false,
    );
    const outputValue = fixture();
    const criterion = outputValue.source.acceptedRequirements[0];
    if (!criterion) throw new Error('Missing criterion');
    outputValue.source.acceptedRequirements = Array.from(
      { length: 21 },
      (_, index) => ({ ...criterion, id: `criterion-${index}` }),
    );
    const bounded = prepareOpportunityResumeFitReview({
      opportunityId: 'role-1',
      ...outputValue,
      candidateMaterialFingerprint: 'candidate-allrows',
    });
    expect((await preflightOpportunityResumeFitReview(bounded)).fits).toBe(
      false,
    );
    expect(mocks.chat).not.toHaveBeenCalled();
  });
  it('holds if the SDK output-envelope count exceeds3500 even when fallback fits', async () => {
    const prepared = await current();
    const counter = vi.fn(async (text: string) =>
      text === prepared.maximumSerializedOutput ? 3501 : 4000,
    );
    const result = await preflightOpportunityResumeFitReview(prepared, counter);
    expect(counter).toHaveBeenCalledWith(prepared.maximumSerializedOutput);
    expect(result.outputShapeTokens).toBe(3501);
    expect(result.fits).toBe(false);
    const parsed = JSON.parse(prepared.maximumSerializedOutput);
    expect(parsed.requirements).toHaveLength(prepared.requirements.length);
    expect(parsed.requirements[0].candidate).toHaveLength(2);
    expect(parsed.requirements[0].note).toHaveLength(48);
    expect(Buffer.byteLength(prepared.maximumSerializedOutput)).toBe(
      prepared.outputShapeBytes,
    );
  });
  it('keeps auxiliary output in the spend guard without raising the100000 limit', async () => {
    const prepared = await current();
    const counted = await preflightOpportunityResumeFitReview(
      prepared,
      async (text) =>
        text === prepared.maximumSerializedOutput ? 1000 : 25744,
    );
    expect(counted.reservedSpendMicros).toBe(96728);
    expect(counted.reservedTokens).toBe(30268);
    expect(counted.fits).toBe(true);
    // The original4096-visible plus1024 reasoning would exceed this same cap.
    expect(
      Math.ceil((25744 * 2000000 + (4096 + 1024) * 10000000) / 1000000),
    ).toBe(102688);
    const denied = await preflightOpportunityResumeFitReview(
      prepared,
      async (text) =>
        text === prepared.maximumSerializedOutput ? 1000 : 27381,
    );
    expect(denied.reservedSpendMicros).toBeGreaterThan(100000);
    expect(denied.fits).toBe(false);
  });
  it('admits complete messages over64KiB when actual token/run/output/spend limits fit', async () => {
    const value = fixture();
    value.candidateSources[149] = {
      id: 'employment:149',
      kind: 'employment',
      title: 'Full native record',
      text: 'x'.repeat(44000),
    };
    const prepared = prepareOpportunityResumeFitReview({
      opportunityId: 'role-1',
      ...value,
      candidateMaterialFingerprint: 'complete-large-catalog',
    });
    const admitted = await preflightOpportunityResumeFitReview(
      prepared,
      async (text) =>
        text === prepared.maximumSerializedOutput ? 1000 : 20000,
    );
    expect(admitted.requestBytes).toBeGreaterThan(65536);
    expect(admitted.fits).toBe(true);
    expect(admitted.reservedSpendMicros).toBeLessThanOrEqual(100000);
    expect(prepared.candidates).toHaveLength(150);
    expect(prepared.candidates[149]?.text).toHaveLength(44000);
  });
  it('exposes only short catalog IDs while restoring original IDs even when an original criterion shadows another alias', () => {
    const value = fixture();
    const original = value.source.acceptedRequirements[0]!;
    value.source.acceptedRequirements = [
      { ...original, id: 'r1' },
      { ...original, id: 'r7' },
    ];
    value.candidateSources[149] = { ...value.candidateSources[149]!, id: 'c0' };
    const prepared = prepareOpportunityResumeFitReview({
      opportunityId: 'role-1',
      ...value,
      candidateMaterialFingerprint: 'candidate-alias',
    });
    const payload = JSON.parse(String(prepared.messages[1]?.content));
    expect(payload.criteria.map((row: { id: string }) => row.id)).toEqual([
      'r0',
      'r1',
    ]);
    expect(
      payload.criteria.every((row: object) => !Object.hasOwn(row, 'key')),
    ).toBe(true);
    expect(payload.candidateCatalog).toHaveLength(150);
    expect(payload.candidateCatalog[149].id).toBe('c149');
    expect(payload.candidateCatalog[149]).not.toHaveProperty('key');
    expect(payload.candidateCatalog[149]).not.toHaveProperty('recordId');
    expect(prepared.candidates[149]!.recordId).toBe('record-149');
    expect(payload.candidateCatalog[149].text).toBe(
      value.candidateSources[149]!.text,
    );
    expect(payload.postingCatalog.map((row: { id: string }) => row.id)).toEqual(
      prepared.clauses.map((row) => row.key),
    );
    expect(
      payload.postingCatalog.every((row: object) => !Object.hasOwn(row, 'key')),
    ).toBe(true);
    expect(prepared.requirements.map((row) => row.id)).toEqual(['r1', 'r7']);
    const answer = output(prepared);
    const actual = resolve(prepared, answer);
    expect(actual.requirements.map((row) => row.id)).toEqual(['r1', 'r7']);
    expect(actual.requirements[0]!.candidateCitations[0]!.sourceId).toBe('c0');
    expect(actual.requirements[0]!.postingCitations[0]!.clauseId).toBe(
      original.clauseIds[0],
    );
    answer.requirements[0]!.id = 'r1';
    expect(() => resolve(prepared, answer)).toThrow('unoffered');
    expect(String(prepared.messages[0]?.content)).toContain('catalog.id');
    expect(prepared.version).toBe(
      'opportunity-resume-fit-review/v2-catalog-aliases',
    );
  });
  it.each([
    'x'.repeat(49),
    'two\nlines',
    'tab\tnote',
    '\u0085',
    '\u2028',
    '\u2029',
  ])('rejects overlong or multiline/control note %j', async (note) => {
    const prepared = await current(),
      value = output(prepared);
    value.requirements[0]!.note = note;
    expect(() => resolve(prepared, value)).toThrow('Invalid');
  });
  it('binds Luna selection and registered pricing while explicit Sol retains its exact historical V2 material hash', async () => {
    const value = fixture();
    const input = {
      opportunityId: 'role-1',
      ...value,
      candidateMaterialFingerprint: 'candidate-model',
    };
    const sol = prepareOpportunityResumeFitReview(input, {
      model: 'openai/gpt-6.1-sol',
    });
    const { model: _model, fingerprint: _fingerprint, ...legacyMaterial } = sol;
    expect(sol.fingerprint).toBe(
      createHash('sha256').update(JSON.stringify(legacyMaterial)).digest('hex'),
    );
    const luna = prepareOpportunityResumeFitReview(input, {
      model: 'openai/gpt-6-luna',
      version: OPPORTUNITY_RESUME_FIT_REVIEW_VERSION,
    });
    expect(luna.model).toBe('openai/gpt-6-luna');
    expect(luna.messages).toEqual(sol.messages);
    expect(luna.candidates).toHaveLength(150);
    expect(luna.fingerprint).not.toBe(sol.fingerprint);
    expect(opportunityResumeFitReviewInputFingerprint(luna, SUBJECT)).not.toBe(
      opportunityResumeFitReviewInputFingerprint(sol, SUBJECT),
    );
    const budget = await preflightOpportunityResumeFitReview(
      luna,
      async (text) => (text === luna.maximumSerializedOutput ? 1000 : 20000),
    );
    expect(budget.reservedSpendMicros).toBe(4262);
    expect(budget.maxOutputTokens).toBe(4524);
    expect(resolve(luna).model).toBe('openai/gpt-6-luna');
    vi.stubEnv(
      'BIFROST_OPPORTUNITY_INTELLIGENCE_SCORING_MODEL',
      'openai/gpt-6-luna',
    );
    expect((await current()).model).toBe('openai/gpt-6-luna');
    expect(
      prepareOpportunityResumeFitReview(input, {
        version: OPPORTUNITY_RESUME_FIT_REVIEW_VERSION,
      }).fingerprint,
    ).toBe(luna.fingerprint);
    expect(
      prepareOpportunityResumeFitReview(input, { model: 'openai/gpt-6.1-sol' })
        .fingerprint,
    ).toBe(sol.fingerprint);
    expect(() =>
      prepareOpportunityResumeFitReview(input, { model: 'invented' as never }),
    ).toThrow('registered');
  });
  it('reads historical Sol only with an explicit model selector and never falls back from current Luna', async () => {
    const sol = await current();
    const actualReceipt = await receipt(sol);
    mocks.query.mockImplementation(async (_sql, params) => ({
      rows: params.includes('openai/gpt-6.1-sol') ? [actualReceipt] : [],
    }));
    vi.stubEnv(
      'BIFROST_OPPORTUNITY_INTELLIGENCE_SCORING_MODEL',
      'openai/gpt-6-luna',
    );
    await expect(
      readCurrentOpportunityResumeFitReviewReceipt(OPPORTUNITY, SUBJECT),
    ).resolves.toBeUndefined();
    expect(
      (
        await readCurrentOpportunityResumeFitReviewReceipt(
          OPPORTUNITY,
          SUBJECT,
          { model: 'openai/gpt-6.1-sol' },
        )
      )?.model,
    ).toBe('openai/gpt-6.1-sol');
  });
  it('uses only the selected Luna client/model and denies changed model material before transport', async () => {
    vi.stubEnv(
      'BIFROST_OPPORTUNITY_INTELLIGENCE_SCORING_MODEL',
      'openai/gpt-6-luna',
    );
    const prepared = await current();
    mocks.chat.mockResolvedValue({
      content: JSON.stringify(quoteOutput(prepared)),
      usage: USAGE,
    });
    const result = await evaluateOpportunityResumeFitReview(prepared, {
      opportunity: OPPORTUNITY,
      subject: SUBJECT,
      agentRunId: 'run-1',
      revalidateMaterial: async () => {},
    });
    expect(result.model).toBe('openai/gpt-6-luna');
    expect(mocks.governed).toHaveBeenLastCalledWith(
      expect.objectContaining({
        identity: expect.objectContaining({ model: 'openai/gpt-6-luna' }),
      }),
    );
    expect(mocks.chat).toHaveBeenLastCalledWith(
      prepared.messages,
      expect.objectContaining({
        model: 'openai/gpt-6-luna',
        maxTokens: 4096,
        reasoning: { effort: 'low', maxTokens: 1024 },
      }),
    );
    mocks.clientModel.mockReturnValue('openai/gpt-6.1-sol');
    await expect(
      evaluateOpportunityResumeFitReview(prepared, {
        opportunity: OPPORTUNITY,
        subject: SUBJECT,
        agentRunId: 'run-1',
        revalidateMaterial: async () => {},
      }),
    ).rejects.toThrow('selected dedicated');
    vi.stubEnv(
      'BIFROST_OPPORTUNITY_INTELLIGENCE_SCORING_MODEL',
      'openai/gpt-6.1-sol',
    );
    await expect(
      evaluateOpportunityResumeFitReview(prepared, {
        opportunity: OPPORTUNITY,
        subject: SUBJECT,
        agentRunId: 'run-1',
        revalidateMaterial: async () => {},
      }),
    ).rejects.toThrow('not current');
    mocks.query.mockResolvedValue({ rows: [] });
    await assertOpportunityResumeFitReviewNotAttempted(prepared, SUBJECT);
    expect(mocks.query).toHaveBeenLastCalledWith(
      expect.any(String),
      expect.arrayContaining(['openai/gpt-6-luna']),
    );
  });
  it('derives unique exact V3 quote spans and original citations without changing explicit V2 material', () => {
    const value = fixture();
    value.candidateSources[149] = {
      ...value.candidateSources[149]!,
      text: 'Distinct 😀platform engineering experience.',
    };
    const input = {
      opportunityId: 'role-1',
      ...value,
      candidateMaterialFingerprint: 'candidate-quotes',
    };
    const v2 = prepareOpportunityResumeFitReview(input, {
      model: 'openai/gpt-6.1-sol',
      version: OPPORTUNITY_RESUME_FIT_REVIEW_VERSION,
    });
    const { model: _model, fingerprint: _fingerprint, ...oldMaterial } = v2;
    expect(v2.fingerprint).toBe(
      createHash('sha256').update(JSON.stringify(oldMaterial)).digest('hex'),
    );
    const v3 = prepareOpportunityResumeFitReview(input, {
      model: 'openai/gpt-6-luna',
    });
    expect(v3.version).toBe(OPPORTUNITY_RESUME_FIT_REVIEW_QUOTE_VERSION);
    expect(v3.candidates).toHaveLength(150);
    expect(v3.visibleOutputTokens).toBe(4096);
    const answer = quoteOutput(v3);
    answer.requirements[0]!.candidate[0]!.quote =
      '😀platform engineering experience.';
    const result = resolve(v3, answer);
    expect(result.contractVersion).toBe(
      OPPORTUNITY_RESUME_FIT_REVIEW_QUOTE_VERSION,
    );
    expect(result.requirements[0]!.candidateCitations[0]).toMatchObject({
      sourceId: 'employment:149',
      start: 9,
      end: 43,
      quote: '😀platform engineering experience.',
    });
    expect(result.requirements[0]!.postingCitations[0]!.clauseId).toBe(
      value.source.acceptedRequirements[0]!.clauseIds[0],
    );
    expect(String(v3.messages[0]?.content)).toContain('EXACT, UNIQUE');
    expect(String(v2.messages[0]?.content)).toContain('UTF-16 offsets');
    expect(() => resolve(v2, answer)).toThrow('Unexpected');
    expect(() => resolve(v3, output(v3))).toThrow('Unexpected');
  });
  it.each([
    'missing',
    'repeated',
    'short',
    'foreign',
    'wrong_parent',
  ])('rejects V3 %s quote evidence without normalization or invented spans', (kind) => {
    const value = fixture();
    if (kind === 'repeated')
      value.candidateSources[149]!.text =
        'Explicit engineering evidence. Explicit engineering evidence.';
    const prepared = prepareOpportunityResumeFitReview(
      {
        opportunityId: 'role-1',
        ...value,
        candidateMaterialFingerprint: 'candidate-quotes',
      },
      { model: 'openai/gpt-6-luna' },
    );
    const answer = quoteOutput(prepared);
    if (kind === 'missing')
      answer.requirements[0]!.candidate[0]!.quote =
        'owned Kubernetes production services during role 149.';
    if (kind === 'repeated')
      answer.requirements[0]!.candidate[0]!.quote =
        'Explicit engineering evidence.';
    if (kind === 'short') answer.requirements[0]!.candidate[0]!.quote = 'Owned';
    if (kind === 'foreign') answer.requirements[0]!.candidate[0]!.id = 'c999';
    if (kind === 'wrong_parent') answer.requirements[0]!.posting[0]!.id = 'p0';
    expect(() => resolve(prepared, answer)).toThrow();
  });
  it('reserves all V3 quote-envelope output and reasoning, holding over4096 without clipping any offered text', async () => {
    const value = fixture();
    value.candidateSources[149]!.text = '\"\\'.repeat(100);
    const prepared = prepareOpportunityResumeFitReview(
      {
        opportunityId: 'role-1',
        ...value,
        candidateMaterialFingerprint: 'candidate-escaped',
      },
      { model: 'openai/gpt-6-luna' },
    );
    const envelope = JSON.parse(prepared.maximumSerializedOutput);
    expect(envelope.requirements).toHaveLength(prepared.requirements.length);
    expect(envelope.requirements[0].candidate).toHaveLength(2);
    expect(envelope.requirements[0].candidate[0].quote).toHaveLength(128);
    expect(envelope.requirements[0].candidate[0]).not.toHaveProperty('start');
    const budget = await preflightOpportunityResumeFitReview(
      prepared,
      async (text) =>
        text === prepared.maximumSerializedOutput ? 2000 : 20000,
    );
    expect(budget.maxOutputTokens).toBe(5120);
    expect(budget.reservedSpendMicros).toBe(4560);
    expect(budget.fits).toBe(true);
    const denied = await preflightOpportunityResumeFitReview(
      prepared,
      async (text) =>
        text === prepared.maximumSerializedOutput ? 4097 : 20000,
    );
    expect(denied.fits).toBe(false);
    expect(prepared.candidates[149]!.text).toBe(
      value.candidateSources[149]!.text,
    );
  });
  it('requires authentic governed identity and rejects fabricated or missing rows', async () => {
    const prepared = await current();
    expect(() =>
      resolveOpportunityResumeFitReview(
        prepared,
        output(prepared),
        '',
        'input',
        'run',
      ),
    ).toThrow('governed');
    expect(() => resolve(prepared, { requirements: [] })).toThrow(
      'Every admitted',
    );
    expect(() =>
      resolve(prepared, { ...output(prepared), fitScore: 99 }),
    ).toThrow('Unexpected');
    const invented = output(prepared);
    invented.requirements[0].id = 'invented';
    expect(() => resolve(prepared, invented)).toThrow('unoffered');
  });
  it.each([
    'invented_id',
    'generated_quote',
    'outside_span',
    'unlinked_posting',
  ])('rejects %s citations', async (kind) => {
    const prepared = await current(),
      value = output(prepared),
      row = value.requirements[0];
    if (kind === 'invented_id') row.candidate[0].id = 'c9999';
    if (kind === 'generated_quote')
      Object.assign(row.candidate[0], { quote: 'Invented' });
    if (kind === 'outside_span') row.candidate[0].end = 999999;
    if (kind === 'unlinked_posting') row.posting[0].id = 'p0';
    expect(() => resolve(prepared, value)).toThrow();
  });
  it('keeps absent candidate evidence uncertain and rejects skill-only seniority', async () => {
    const prepared = await current(),
      value = output(prepared);
    value.requirements[0].status = 'uncertain';
    value.requirements[0].candidate = [];
    expect(resolve(prepared, value).requirements[0]?.status).toBe('uncertain');
    value.requirements[0].status = 'strength';
    expect(() => resolve(prepared, value)).toThrow('candidate citation');
    const skillPrepared = structuredClone(prepared);
    const tail = skillPrepared.candidates.at(-1);
    if (!tail) throw new Error('Missing tail');
    tail.kind = 'skill';
    const seniority = output(skillPrepared);
    seniority.requirements[0].seniority = 'supported';
    expect(() => resolve(skillPrepared, seniority)).toThrow('Named skills');
  });
  it('rejects spans splitting a surrogate pair', async () => {
    const prepared = await current();
    const tail = prepared.candidates.at(-1);
    if (!tail) throw new Error('Missing tail');
    tail.text = 'A😀B';
    const value = output(prepared);
    value.requirements[0].candidate[0].start = 2;
    expect(() => resolve(prepared, value)).toThrow('source character');
  });
  it('rejects a stale cached profile occurrence and foreign/inactive fresh profiles', async () => {
    mocks.getProfile.mockResolvedValueOnce({
      id: PROFILE.id,
      toJSON: () => ({ ...PROFILE, summary: 'Fresh changed summary' }),
    });
    await expect(current()).rejects.toThrow('stale profile');
    mocks.getProfile.mockResolvedValueOnce({
      id: PROFILE.id,
      toJSON: () => ({ ...PROFILE, ownerUserId: 'other' }),
    });
    await expect(current()).rejects.toThrow('owned');
    mocks.getProfile.mockResolvedValueOnce({
      id: PROFILE.id,
      toJSON: () => ({ ...PROFILE, active: false }),
    });
    await expect(current()).rejects.toThrow('active');
    expect(mocks.getProfile).toHaveBeenCalledWith(
      { id: SUBJECT.profileId },
      { cache: false },
    );
  });
  it('passes the authentic governance ID and fences both sides of transport', async () => {
    const prepared = await current();
    mocks.chat.mockResolvedValue({
      content: JSON.stringify(output(prepared)),
      usage: USAGE,
    });
    const revalidateMaterial = vi.fn(async () => undefined);
    const result = await evaluateOpportunityResumeFitReview(prepared, {
      opportunity: OPPORTUNITY,
      subject: SUBJECT,
      agentRunId: 'run-1',
      revalidateMaterial,
    });
    expect(result.requestId).toBe('governed-1');
    expect(result.agentRunId).toBe('run-1');
    expect(mocks.chat.mock.calls[0]?.[1]).toMatchObject({
      model: OPPORTUNITY_RESUME_FIT_REVIEW_MODEL,
      user: 'governed-1',
      maxTokens: 3500,
      reasoning: { effort: 'low', maxTokens: 1024 },
    });
    expect(revalidateMaterial).toHaveBeenCalledTimes(3);
    expect(mocks.governed.mock.calls[0]?.[0]).toMatchObject({
      workspaceSubject: SUBJECT,
      maxOutputTokens: 4524,
    });
  });
  it('does not transport after authority revocation and retains actual usage on postresponse failures', async () => {
    const prepared = await current();
    await expect(
      evaluateOpportunityResumeFitReview(prepared, {
        opportunity: OPPORTUNITY,
        subject: SUBJECT,
        agentRunId: 'run-1',
        revalidateMaterial: async () => {
          throw new Error('Revoked');
        },
      }),
    ).rejects.toThrow('Revoked');
    expect(mocks.chat).not.toHaveBeenCalled();
    mocks.chat.mockResolvedValue({
      content: '{"requirements":[]}',
      usage: USAGE,
    });
    await expect(
      evaluateOpportunityResumeFitReview(prepared, {
        opportunity: OPPORTUNITY,
        subject: SUBJECT,
        agentRunId: 'run-1',
        revalidateMaterial: async () => undefined,
      }),
    ).rejects.toThrow('Every admitted');
    expect(mocks.metadata).toHaveBeenCalledWith(expect.any(Error), {
      usage: USAGE,
    });
    mocks.chat.mockResolvedValue({
      content: JSON.stringify(output(prepared)),
      usage: USAGE,
    });
    const fence = vi
      .fn()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('Source changed'));
    await expect(
      evaluateOpportunityResumeFitReview(prepared, {
        opportunity: OPPORTUNITY,
        subject: SUBJECT,
        agentRunId: 'run-1',
        revalidateMaterial: fence,
      }),
    ).rejects.toThrow('Source changed');
    expect(mocks.metadata).toHaveBeenLastCalledWith(expect.any(Error), {
      usage: USAGE,
    });
  });
  it('refuses another attempt of the exact private input identity', async () => {
    const prepared = await current();
    mocks.query.mockResolvedValue({ rows: [{ request_id: 'failed-old' }] });
    await expect(
      assertOpportunityResumeFitReviewNotAttempted(prepared, SUBJECT),
    ).rejects.toThrow('recorded attempt');
    expect(mocks.query.mock.calls[0]?.[1]).toContain(
      opportunityResumeFitReviewInputFingerprint(prepared, SUBJECT),
    );
  });
  it('replays only joined actual PRIVATE receipts with current material and run caps', async () => {
    const prepared = await current();
    const actualReceipt = await receipt(prepared);
    mocks.query.mockResolvedValue({ rows: [actualReceipt] });
    expect(
      (await readCurrentOpportunityResumeFitReviewReceipt(OPPORTUNITY, SUBJECT))
        ?.requestId,
    ).toBe('governed-1');
    const sql = String(mocks.query.mock.calls[0]?.[0]);
    expect(sql).toContain('JOIN opportunity_intelligence_requests q');
    expect(sql).toContain('JOIN agent_runs a');
    expect(sql).toContain("q.accounting_basis = 'actual'");
    expect(sql).toContain('q.actual_total_tokens > 0');
    expect(sql).toContain('q.tenant_id = r.tenant_id');
    expect(sql).toContain('r.prompt_version = ?');
    expect(sql).not.toContain('q.prompt_version');
    for (const patch of [
      { request_id: 'orphan' },
      { run_status: 'failed' },
      { run_actual_tokens: 80001 },
      { requested_max_output_tokens: 1 },
      { reserved_spend_micros: 0 },
      { reserved_input_tokens: actualReceipt.reserved_input_tokens - 1 },
      { agent_run_id: '' },
    ]) {
      mocks.query.mockResolvedValueOnce({
        rows: [{ ...actualReceipt, ...patch }],
      });
      expect(
        await readCurrentOpportunityResumeFitReviewReceipt(
          OPPORTUNITY,
          SUBJECT,
        ),
      ).toBeUndefined();
    }
    mocks.query.mockResolvedValueOnce({
      rows: [actualReceipt, actualReceipt],
    });
    expect(
      await readCurrentOpportunityResumeFitReviewReceipt(OPPORTUNITY, SUBJECT),
    ).toBeUndefined();
  });
  it('does not display a successful provider response without an owned saved assessment', async () => {
    const prepared = await current();
    mocks.query.mockResolvedValue({ rows: [await receipt(prepared)] });
    mocks.readSource.mockClear();
    expect(
      await readCurrentOpportunityResumeFitReview(OPPORTUNITY, SUBJECT),
    ).toBeUndefined();
    expect(mocks.readSource).not.toHaveBeenCalled();
    expect(mocks.query).not.toHaveBeenCalled();
  });
  it('persists a separate advisory contract using authentic receipt, preserving partial/full records', async () => {
    const prepared = await current(),
      result = resolve(prepared);
    mocks.query.mockResolvedValue({ rows: [await receipt(prepared)] });
    expect(
      await storeOpportunityResumeFitReview({
        prepared,
        result,
        opportunity: OPPORTUNITY,
        subject: SUBJECT,
        agentRunId: 'run-1',
      }),
    ).toBe(true);
    expect(mocks.create).toHaveBeenCalledWith(
      'OpportunityAssessment',
      SUBJECT,
      expect.objectContaining({
        contractVersion: OPPORTUNITY_RESUME_FIT_REVIEW_VERSION,
        status: 'advisory',
        eligibilityBucket: 'unknown',
        eligibilityPriority: 2,
        matchReadiness: 'needs_evidence',
        excluded: false,
      }),
    );
    const saved = mocks.create.mock.calls[0]?.[2];
    expect(saved).not.toHaveProperty('fitScore');
    expect(saved.assessmentJson).toBe(JSON.stringify(result));
    mocks.list.mockResolvedValue([saved]);
    expect(
      await readCurrentOpportunityResumeFitReview(OPPORTUNITY, SUBJECT),
    ).toEqual(result);
    await expect(
      storeOpportunityResumeFitReview({
        prepared,
        result: { ...result, requestId: 'invented' },
        opportunity: OPPORTUNITY,
        subject: SUBJECT,
        agentRunId: 'run-1',
      }),
    ).rejects.toThrow('actual PRIVATE');
  });
  it('finds the exact current saved fingerprint beyond old history and rejects duplicates', async () => {
    const prepared = await current(),
      result = resolve(prepared);
    const saved = {
      opportunityId: prepared.opportunityId,
      assessmentFingerprint: result.fingerprint,
      contractVersion: result.contractVersion,
      status: 'advisory',
      sourceContentFingerprint: result.sourceContentFingerprint,
      sourceContentVersion: result.sourceContentVersion,
      candidateMaterialFingerprint: result.candidateMaterialFingerprint,
      agentRunId: result.agentRunId,
      assessmentJson: JSON.stringify(result),
    };
    mocks.query.mockResolvedValue({ rows: [await receipt(prepared)] });
    const history = [0, 1, 2].map((index) => ({
      ...saved,
      assessmentFingerprint: `old-${index}`,
    }));
    mocks.list.mockImplementation(async (_name, _subject, options) =>
      options.where.assessmentFingerprint === saved.assessmentFingerprint
        ? [saved]
        : history.slice(0, options.limit),
    );
    expect(
      await readCurrentOpportunityResumeFitReview(OPPORTUNITY, SUBJECT),
    ).toEqual(result);
    expect(mocks.list.mock.calls.at(-1)?.[2]).toMatchObject({
      limit: 2,
      where: { assessmentFingerprint: saved.assessmentFingerprint },
    });
    mocks.list.mockImplementation(async (_name, _subject, options) =>
      options.where.assessmentFingerprint ? [saved, saved] : [history[0]],
    );
    expect(
      await readCurrentOpportunityResumeFitReview(OPPORTUNITY, SUBJECT),
    ).toBeUndefined();
  });
});
