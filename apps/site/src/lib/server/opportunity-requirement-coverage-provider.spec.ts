import type { DecisionResult } from '@happyvertical/ai';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  buildRequirementCoverageSource,
  type CoverageLedger,
  type RequirementCoverageContext,
  requirementCoverageContextForOpportunity,
  validateRequirementCoverage,
} from './opportunity-requirement-coverage.js';
import {
  hasRecordedRequirementCoverageAudit,
  preflightRequirementCoverageAudit,
  preflightRequirementCoverageLifecycle,
  prepareRequirementCoverageAudit,
  readRecordedRequirementCoverageOutcome,
  requirementCoverageAuditReservationCeiling,
  requirementCoverageClauseQuestionKey,
  requirementCoverageSourceDependencyFingerprint,
  resolveRequirementCoverageAudit,
  validateVerifiedRequirementCoverage,
} from './opportunity-requirement-coverage-provider.js';

const mocks = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock('@happyvertical/smrt-core', () => ({
  resolveDatabase: async () => ({ query: mocks.query }),
}));
vi.mock('./db.js', () => ({ getDbConfig: () => ({}) }));
vi.mock('./opportunity-intelligence-governance.js', () => ({
  executeGovernedOpportunityIntelligenceRequest: vi.fn(),
}));

function fixture() {
  const context: RequirementCoverageContext = {
    sourceText:
      'About the role\nDiagnose complex failure modes across a service mesh and prevent recurrence.\nApply now',
    sourceFingerprint: 'source-1',
    sourceVersion: 1,
    extractionFingerprint: 'extraction-1',
  };
  const ledger = buildRequirementCoverageSource(context);
  const duty = ledger.clauses[1]!;
  ledger.requirements = [
    {
      id: 'duty-1',
      text: duty.text,
      clauseIds: [duty.id],
      importance: 'unknown',
    },
  ];
  ledger.dispositions = ledger.clauses.map((clause, index) =>
    index === 1
      ? { clauseId: clause.id, type: 'role_duty', requirementIds: ['duty-1'] }
      : {
          clauseId: clause.id,
          type: 'nonrequirement',
          requirementIds: [],
          exclusionRule: index === 0 ? 'section_heading' : 'navigation_label',
        },
  );
  const prepared = prepareRequirementCoverageAudit(context, ledger);
  const result = {
    answers: Object.fromEntries(
      Object.keys(prepared.request.questions).map((key) => [
        key,
        { type: 'predicate', probability: 0.9 },
      ]),
    ),
  } as DecisionResult;
  ledger.audit = resolveRequirementCoverageAudit(prepared, result, 'receipt-1');
  return { context, ledger, prepared, result };
}

describe('source requirement coverage audit', () => {
  beforeEach(() => vi.resetAllMocks());

  it('binds full literal clause and qualifiers in each question, including exclusion review', () => {
    const { prepared, ledger } = fixture();
    expect(
      prepared.request.questions[
        requirementCoverageClauseQuestionKey(1, 'mapped')
      ].instructions,
    ).toContain('state.clauses.c1.text');
    expect(
      prepared.request.questions[
        requirementCoverageClauseQuestionKey(1, 'mapped')
      ].instructions,
    ).toContain('every qualifier');
    expect(
      prepared.request.questions[
        requirementCoverageClauseQuestionKey(0, 'nonmaterial')
      ].instructions,
    ).toContain('NO material candidate qualification');
    expect(prepared.request.state).toEqual({
      source: prepared.context.sourceText,
      clauses: Object.fromEntries(
        ledger.clauses.map((clause, index) => [
          `c${index}`,
          { text: clause.text, kind: clause.kind, section: clause.section },
        ]),
      ),
      requirements: {
        r0: { text: ledger.requirements[0]!.text, clauseKeys: ['c1'] },
      },
    });
    expect(
      prepared.request.questions[
        requirementCoverageClauseQuestionKey(1, 'mapped')
      ].instructions,
    ).toContain('["r0"]');
    const preflight = preflightRequirementCoverageAudit(prepared);
    expect(preflight.requestBytes).toBe(
      Buffer.byteLength(JSON.stringify(prepared.request), 'utf8'),
    );
    expect(preflight.requestBytes).toBeLessThanOrEqual(
      requirementCoverageAuditReservationCeiling(
        prepared.context.sourceText,
        ledger.clauses.length,
      ).requestBytes,
    );
    expect(preflight.fits).toBe(true);
  });

  it('keeps an explicit pending body context incomplete until its exact independent global audit affirms nonmateriality', async () => {
    const context: RequirementCoverageContext = {
      ...fixture().context,
      sourceText:
        'About the role\nOur people meet for social lunches.\nApply now',
    };
    const ledger = buildRequirementCoverageSource(context);
    ledger.dispositions[1] = {
      clauseId: ledger.clauses[1]!.id,
      type: 'role_context',
      requirementIds: [],
      auditPending: 'nonmaterial',
    };
    ledger.dispositions[2] = {
      clauseId: ledger.clauses[2]!.id,
      type: 'nonrequirement',
      requirementIds: [],
      exclusionRule: 'navigation_label',
    };
    expect(
      validateRequirementCoverage(context, ledger).structuralComplete,
    ).toBe(false);
    expect(validateVerifiedRequirementCoverage(context, ledger).complete).toBe(
      false,
    );
    const prepared = prepareRequirementCoverageAudit(context, ledger);
    const question =
      prepared.request.questions[
        requirementCoverageClauseQuestionKey(1, 'nonmaterial')
      ].instructions;
    expect(question).toContain('state.clauses.c1.text');
    expect(question).toContain('presence in raw state proves nothing');
    expect(question).toContain(
      'Any omitted material criterion or uncertainty is false',
    );
    const result: DecisionResult = {
      model: 'jev-test',
      provenance: { model: 'jev-test', provider: 'typesafe' },
      answers: Object.fromEntries(
        Object.keys(prepared.request.questions).map((key) => [
          key,
          { type: 'predicate', probability: 0.9 },
        ]),
      ),
    };
    result.answers[requirementCoverageClauseQuestionKey(1, 'nonmaterial')] = {
      type: 'predicate',
      probability: 0.84,
    };
    ledger.audit = resolveRequirementCoverageAudit(
      prepared,
      result,
      'pending-receipt',
    );
    expect(validateVerifiedRequirementCoverage(context, ledger).complete).toBe(
      false,
    );
    result.answers[requirementCoverageClauseQuestionKey(1, 'nonmaterial')] = {
      type: 'predicate',
      probability: 0.9,
    };
    ledger.audit = resolveRequirementCoverageAudit(
      prepared,
      result,
      'pending-receipt',
    );
    expect(validateVerifiedRequirementCoverage(context, ledger).complete).toBe(
      true,
    );
    mocks.query.mockResolvedValue({ rows: [] });
    await expect(
      hasRecordedRequirementCoverageAudit('role-pending', context, ledger),
    ).resolves.toBe(false);
    mocks.query.mockResolvedValue({
      rows: [{ output_json: JSON.stringify(result) }],
    });
    await expect(
      hasRecordedRequirementCoverageAudit('role-pending', context, ledger),
    ).resolves.toBe(true);
    const unmarked = structuredClone(ledger);
    delete unmarked.dispositions[1]!.auditPending;
    expect(() => prepareRequirementCoverageAudit(context, unmarked)).toThrow(
      'admissible',
    );
    expect(
      validateVerifiedRequirementCoverage(context, unmarked).complete,
    ).toBe(false);
    expect(ledger.dispositions[1]!.type).toBe('role_context');
    expect(ledger.dispositions[1]!.requirementIds).toEqual([]);
    expect(ledger.requirements).toEqual([]);
  });

  it('rejects incomplete semantics, malformed answers and unknown audit provenance', () => {
    const { prepared, ledger, context, result } = fixture();
    result.answers[requirementCoverageClauseQuestionKey(1, 'mapped')] = {
      type: 'predicate',
      probability: 0.84,
    };
    ledger.audit = resolveRequirementCoverageAudit(
      prepared,
      result,
      'receipt-1',
    );
    expect(validateVerifiedRequirementCoverage(context, ledger).complete).toBe(
      false,
    );
    delete result.answers[requirementCoverageClauseQuestionKey(1, 'mapped')];
    expect(() =>
      resolveRequirementCoverageAudit(prepared, result, 'receipt-1'),
    ).toThrow('Malformed source coverage');
    const noReceipt = fixture();
    noReceipt.ledger.audit = resolveRequirementCoverageAudit(
      noReceipt.prepared,
      noReceipt.result,
    );
    expect(
      validateVerifiedRequirementCoverage(noReceipt.context, noReceipt.ledger)
        .complete,
    ).toBe(false);
  });

  it('normalizes unverified importance while preserving complete clause semantics', () => {
    const { context, ledger } = fixture();
    ledger.requirements[0]!.importance = 'required';
    const prepared = prepareRequirementCoverageAudit(context, ledger);
    expect(
      prepared.request.questions.importance_0_explicit.instructions,
    ).toContain('state.requirements.r0.text');
    const result = {
      answers: Object.fromEntries(
        Object.keys(prepared.request.questions).map((key) => [
          key,
          {
            type: 'predicate',
            probability: key.startsWith('importance_') ? 0.84 : 0.9,
          },
        ]),
      ),
    } as DecisionResult;
    ledger.audit = resolveRequirementCoverageAudit(
      prepared,
      result,
      'receipt-2',
    );
    expect(ledger.audit.importance['duty-1']).toBe('unknown');
    expect(validateVerifiedRequirementCoverage(context, ledger).complete).toBe(
      true,
    );
    result.answers.importance_0_explicit = {
      type: 'predicate',
      probability: 0.95,
    };
    ledger.audit = resolveRequirementCoverageAudit(
      prepared,
      result,
      'receipt-3',
    );
    expect(ledger.audit.importance['duty-1']).toBe('required');
    expect(validateVerifiedRequirementCoverage(context, ledger).complete).toBe(
      true,
    );
  });

  it('keeps unoffered importance unknown and retains all literal source meaning', () => {
    const context: RequirementCoverageContext = {
      sourceText: Array.from(
        { length: 50 },
        (_, index) =>
          `Required qualification ${index}: retain detail ${index}.`,
      ).join('\n'),
      sourceFingerprint: 'source-many',
      sourceVersion: 1,
      extractionFingerprint: 'extract-many',
    };
    const ledger = buildRequirementCoverageSource(context);
    ledger.requirements = ledger.clauses.map((clause, index) => ({
      id: `criterion-${index}`,
      text: clause.text,
      clauseIds: [clause.id],
      importance: 'required',
    }));
    ledger.dispositions = ledger.clauses.map((clause, index) => ({
      clauseId: clause.id,
      type: 'material_requirement',
      requirementIds: [`criterion-${index}`],
    }));
    const prepared = prepareRequirementCoverageAudit(context, ledger);
    const offered = new Set(Object.values(prepared.questionRequirementIds));
    expect(offered.size).toBeGreaterThan(0);
    expect(offered.size).toBeLessThan(ledger.requirements.length);
    expect(Object.keys(prepared.questionClauseIds)).toHaveLength(50);
    expect(JSON.stringify(prepared.request.state)).toContain(
      ledger.requirements[49]!.text,
    );
    ledger.audit = resolveRequirementCoverageAudit(
      prepared,
      {
        model: 'jev-test',
        provenance: { model: 'jev-test', provider: 'typesafe' },
        answers: Object.fromEntries(
          Object.keys(prepared.request.questions).map((key) => [
            key,
            { type: 'predicate', probability: 0.95 },
          ]),
        ),
      },
      'receipt-many',
    );
    for (const requirement of ledger.requirements)
      expect(ledger.audit.importance[requirement.id]).toBe(
        offered.has(requirement.id) ? 'required' : 'unknown',
      );
    expect(validateVerifiedRequirementCoverage(context, ledger).complete).toBe(
      true,
    );
  });

  it('uses a stable source intent across deterministic preparation and distinguishes recorded negative confidence', async () => {
    const opportunity = {
      id: 'role-1',
      descriptionRaw: 'Platform work.',
      sourceContentFingerprint: 'source-1',
      sourceContentVersion: 1,
    };
    expect(requirementCoverageSourceDependencyFingerprint(opportunity)).toBe(
      requirementCoverageSourceDependencyFingerprint({
        ...opportunity,
        preparedPostingFingerprint: 'previous-preparation',
      }),
    );
    const context = requirementCoverageContextForOpportunity(opportunity);
    const ledger = buildRequirementCoverageSource(context);
    ledger.requirements = [
      {
        id: 'r1',
        text: ledger.clauses[0]!.text,
        clauseIds: [ledger.clauses[0]!.id],
        importance: 'unknown',
      },
    ];
    ledger.dispositions = [
      {
        clauseId: ledger.clauses[0]!.id,
        type: 'role_duty',
        requirementIds: ['r1'],
      },
    ];
    const prepared = prepareRequirementCoverageAudit(context, ledger);
    const result: DecisionResult = {
      model: 'jev-test',
      provenance: { model: 'jev-test', provider: 'typesafe' },
      answers: {
        [requirementCoverageClauseQuestionKey(0, 'mapped')]: {
          type: 'predicate',
          probability: 0.5,
        },
      },
    };
    ledger.audit = resolveRequirementCoverageAudit(
      prepared,
      result,
      'negative-receipt',
    );
    const cached = {
      ...opportunity,
      preparedPostingJson: JSON.stringify({ requirementCoverage: ledger }),
    };
    mocks.query.mockResolvedValue({
      rows: [{ output_json: JSON.stringify(result) }],
    });
    await expect(
      readRecordedRequirementCoverageOutcome('role-1', cached),
    ).resolves.toMatchObject({ status: 'blocked', reason: 'confidence' });
    mocks.query.mockResolvedValue({ rows: [] });
    await expect(
      readRecordedRequirementCoverageOutcome('role-1', cached),
    ).resolves.toEqual({ status: 'missing' });
  });

  it('blocks paid failed source identities while keeping pre-provider revocation missing', async () => {
    const opportunity = {
      id: 'role-failed',
      descriptionRaw: 'Platform reliability.',
      sourceContentFingerprint: 'source-failed',
      sourceContentVersion: 1,
    };
    const bridge = {
      sourcePreparationAgentRunId: 'server-saved-run',
      sourceDependencyFingerprint:
        requirementCoverageSourceDependencyFingerprint(opportunity),
    };
    mocks.query.mockResolvedValue({
      rows: [
        {
          status: 'failed',
          accounting_basis: 'conservative',
          actual_total_tokens: 0,
          request_id: 'internal-1',
          provider_request_id: 'internal-1',
          owner_request_id: 'internal-1',
        },
      ],
    });
    await expect(
      readRecordedRequirementCoverageOutcome(
        'role-failed',
        opportunity,
        bridge,
      ),
    ).resolves.toEqual({ status: 'missing' });
    mocks.query.mockResolvedValue({
      rows: [
        {
          status: 'failed',
          accounting_basis: 'actual',
          actual_total_tokens: 42,
          request_id: 'request-1',
          provider_request_id: 'provider-1',
          owner_request_id: 'request-1',
        },
      ],
    });
    await expect(
      readRecordedRequirementCoverageOutcome(
        'role-failed',
        opportunity,
        bridge,
      ),
    ).resolves.toMatchObject({ status: 'blocked', reason: 'attempt_failed' });
    expect(mocks.query.mock.calls[1]![1]).toContain('server-saved-run');
  });

  it('shares a paid failed GLOBAL audit across profiles without a native cache or job bridge', async () => {
    const opportunity = {
      id: 'role-global',
      descriptionRaw: 'Platform reliability.',
      sourceContentFingerprint: 'source-global',
      sourceContentVersion: 1,
    };
    const extraction = {
      status: 'completed',
      feature: 'opportunity-extraction-chunk-0',
      output_json: JSON.stringify({
        requirementCoverage: {
          requirements: [
            {
              id: 'r1',
              text: 'Platform reliability.',
              clauseIds: ['c0'],
              importance: 'unknown',
            },
          ],
          dispositions: [
            { clauseId: 'c0', type: 'role_duty', requirementIds: ['r1'] },
          ],
        },
      }),
    };
    const failed = {
      owner_request_id: 'audit-request',
      request_id: 'audit-request',
      provider_request_id: 'actual-provider-request',
      accounting_basis: 'actual',
      actual_total_tokens: 42,
    };
    mocks.query
      .mockResolvedValueOnce({ rows: [extraction] })
      .mockResolvedValueOnce({ rows: [failed] })
      .mockResolvedValueOnce({ rows: [extraction] })
      .mockResolvedValueOnce({ rows: [failed] });
    const profileA = await readRecordedRequirementCoverageOutcome(
      'role-global',
      {
        ...opportunity,
        tenantId: 'tenant-a',
        candidateProfileId: 'profile-a',
      },
    );
    const profileB = await readRecordedRequirementCoverageOutcome(
      'role-global',
      {
        ...opportunity,
        tenantId: 'tenant-b',
        candidateProfileId: 'profile-b',
      },
    );
    expect(profileA).toMatchObject({
      status: 'blocked',
      reason: 'attempt_failed',
    });
    expect(profileB).toEqual(profileA);
    expect(mocks.query.mock.calls[1]![1]).toEqual(
      mocks.query.mock.calls[3]![1],
    );
    expect(mocks.query.mock.calls[1]![0]).toContain(
      "COALESCE(r.candidate_profile_id, '') = ''",
    );
    expect(JSON.stringify(profileA)).not.toContain('tenant-a');
    // Conservative accounting with an internal ID cannot poison the shared source.
    mocks.query
      .mockResolvedValueOnce({ rows: [extraction] })
      .mockResolvedValueOnce({
        rows: [
          {
            ...failed,
            accounting_basis: 'conservative',
            actual_total_tokens: 0,
            provider_request_id: failed.request_id,
            error_code: 'usage_accounting_missing',
            output_json: '{}',
          },
        ],
      });
    await expect(
      readRecordedRequirementCoverageOutcome('role-global', opportunity),
    ).resolves.toEqual({ status: 'missing' });
  });

  it('invalidates changed source, mappings, text or a reused audit on a new extraction', () => {
    const { ledger, context } = fixture();
    expect(validateVerifiedRequirementCoverage(context, ledger).complete).toBe(
      true,
    );
    expect(
      validateVerifiedRequirementCoverage(
        { ...context, sourceText: `${context.sourceText}!` },
        ledger,
      ).complete,
    ).toBe(false);
    expect(
      validateVerifiedRequirementCoverage(
        { ...context, extractionFingerprint: 'extraction-2' },
        ledger,
      ).complete,
    ).toBe(false);
    const changed: CoverageLedger = structuredClone(ledger);
    changed.requirements[0]!.text = 'Service mesh';
    expect(validateVerifiedRequirementCoverage(context, changed).complete).toBe(
      false,
    );
  });

  it('requires the exact completed global governance output, not an injected JSON cache', async () => {
    const { context, ledger, result } = fixture();
    mocks.query.mockResolvedValue({ rows: [] });
    await expect(
      hasRecordedRequirementCoverageAudit('role-1', context, ledger),
    ).resolves.toBe(false);
    mocks.query.mockResolvedValue({
      rows: [{ output_json: JSON.stringify(result) }],
    });
    await expect(
      hasRecordedRequirementCoverageAudit('role-1', context, ledger),
    ).resolves.toBe(true);
    expect(mocks.query.mock.calls[1]![0]).toContain(
      "COALESCE(candidate_profile_id, '') = ''",
    );
    result.answers[requirementCoverageClauseQuestionKey(1, 'mapped')] = {
      type: 'predicate',
      probability: 0.5,
    };
    mocks.query.mockResolvedValue({
      rows: [{ output_json: JSON.stringify(result) }],
    });
    await expect(
      hasRecordedRequirementCoverageAudit('role-1', context, ledger),
    ).resolves.toBe(false);
  });

  it('counts every source/private stage and rejects an unfit combined lifecycle', () => {
    const limits = { calls: 4, inputTokens: 80_000 };
    expect(
      preflightRequirementCoverageLifecycle(
        [
          { calls: 1, reservedTokens: 77_824 },
          { calls: 1, reservedTokens: 10_000 },
        ],
        limits,
      ).fits,
    ).toBe(false);
    expect(
      preflightRequirementCoverageLifecycle(
        [
          { calls: 3, reservedTokens: 30_000 },
          { calls: 2, reservedTokens: 10_000 },
        ],
        limits,
      ).fits,
    ).toBe(false);
    expect(
      preflightRequirementCoverageLifecycle(
        [
          { calls: 1, reservedTokens: 20_000 },
          { calls: 1, reservedTokens: 15_000 },
        ],
        limits,
      ),
    ).toEqual({ calls: 2, reservedTokens: 35_000, fits: true });
  });
});
