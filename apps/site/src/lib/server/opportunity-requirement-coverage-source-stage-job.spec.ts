import type { DecisionResult } from '@happyvertical/ai';
import type { PrincipalRun } from '@happyvertical/smrt-agents';
import type { JobExecutionContext, SmrtJob } from '@happyvertical/smrt-jobs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { processOpportunityWithLlm } from './opportunity-details.js';
import { prepareOpportunityPosting } from './opportunity-posting-preparation.js';
import {
  buildRequirementCoverageSource,
  REQUIREMENT_COVERAGE_EXTRACTION_PROMPT_VERSION,
  REQUIREMENT_COVERAGE_EXTRACTION_SCHEMA_VERSION,
  requirementCoverageContextForOpportunity,
} from './opportunity-requirement-coverage.js';
import {
  type PreparedRequirementEvidenceAudit,
  partialRequirementEvidenceFromAudit,
  REQUIREMENT_EVIDENCE_AUDIT_VERSION,
  REQUIREMENT_EVIDENCE_CAPTURED_SOURCE_AUDIT_VERSION,
  REQUIREMENT_EVIDENCE_ELIGIBILITY_AUDIT_VERSION,
  requirementCoverageLedgerFingerprint,
  resolveRequirementCoverageAudit,
  resolveRequirementEvidenceAudit,
} from './opportunity-requirement-coverage-provider.js';
import {
  assertOpportunitySourceExtractionNotAttempted,
  attestCompletedOpportunitySourceExtraction,
  preflightCompletedOpportunityRequirementEvidenceAudit,
  runOpportunityRequirementCoverageSourceStageJob,
  SOURCE_COVERAGE_STAGE_JOB_CONTRACT,
} from './opportunity-requirement-coverage-source-stage-job.js';
import {
  OPPORTUNITY_SCREENING_V1_VERSION,
  OPPORTUNITY_SCREENING_VERSION,
} from './opportunity-screening.js';
import {
  fingerprintOpportunitySourceContent,
  opportunityWithSourceContent,
} from './opportunity-source-content.js';
import type { SourceEligibilityEvidenceContext } from './source-eligibility-facts.js';

type Dependencies = NonNullable<
  Parameters<typeof runOpportunityRequirementCoverageSourceStageJob>[3]
>;
type TransactionDatabase = Parameters<
  Parameters<NonNullable<Dependencies['transaction']>>[0]
>[0];

const runnerState = vi.hoisted(() => ({ active: undefined as unknown }));
vi.mock('./db.js', () => ({
  getDbConfig: () => ({}),
  getSmrtOptions: () => ({}),
}));
vi.mock('./application-workflow.js', () => ({
  runOpportunityLifecycleTransaction: vi.fn(),
  withOpportunityLifecycleLock: vi.fn(),
}));
vi.mock('./opportunity-details.js', () => ({
  defaultFencedOpportunityUpdate: vi.fn(),
  processOpportunityWithLlm: vi.fn(),
}));
vi.mock('./opportunity-intelligence-governance.js', () => ({
  startOpportunityIntelligenceAgentRun: vi.fn(),
  finishOpportunityIntelligenceAgentRun: vi.fn(),
}));
vi.mock('./smrt.js', () => ({ getCollection: vi.fn() }));
vi.mock('./source-crawl-operator.js', () => ({
  requireSourceCrawlOperator: vi.fn(),
}));
vi.mock('./job-workspace-subject.js', () => ({
  requireActiveRunnerExecutionContext: (context: unknown) => {
    if (context !== runnerState.active)
      throw new Error('Not active runner context.');
    return context;
  },
  runtimeWorkspaceSubjectFromJobArgs: (args: Record<string, unknown>) =>
    args.runtimeWorkspaceSubject,
  runAsRevalidatedJobWorkspaceSubject: vi.fn(),
  withRuntimeWorkspaceSubject: vi.fn(),
}));
vi.mock('./opportunity-requirement-coverage-provider.js', async (original) => ({
  ...(await original<
    typeof import('./opportunity-requirement-coverage-provider.js')
  >()),
  requirementCoverageSourceDependencyFingerprint: () => 'source-seed',
}));

const subject = {
  tenantId: 'tenant-1',
  userId: 'user-1',
  profileId: 'profile-1',
};
function fixture(
  descriptionRaw = 'Requirements\nBuild reliable software.',
  capturedFields?: { locationNotes: string; workMode: string },
) {
  const opportunity: Record<string, unknown> = {
    id: 'opportunity-1',
    title: 'Source stage role',
    descriptionRaw,
    sourceContentFingerprint: 'source-1',
    sourceContentVersion: 1,
  };
  if (capturedFields) {
    const content = {
      title: opportunity.title,
      descriptionRaw,
      ...capturedFields,
    };
    opportunity.sourceContentJson = JSON.stringify(content);
    opportunity.sourceContentFingerprint =
      fingerprintOpportunitySourceContent(content);
  }
  const posting = prepareOpportunityPosting(
    opportunityWithSourceContent(opportunity),
  );
  opportunity.preparedPostingFingerprint = posting.fingerprint;
  const context = requirementCoverageContextForOpportunity(opportunity);
  const ledger = buildRequirementCoverageSource(context);
  const body = ledger.clauses.find((clause) => clause.kind === 'body')!;
  ledger.requirements = [
    { id: 'r1', text: body.text, clauseIds: [body.id], importance: 'unknown' },
  ];
  ledger.dispositions = ledger.dispositions.map((row) =>
    row.clauseId === body.id
      ? {
          clauseId: body.id,
          type: 'material_requirement',
          requirementIds: ['r1'],
        }
      : row,
  );
  const row: Record<string, unknown> = {
    owner_request_id: 'native-request-1',
    result_request_id: 'native-request-1',
    result_idempotency_key: 'native-idempotency',
    request_idempotency_key: 'native-idempotency',
    request_id: 'native-request-1',
    opportunity_id: opportunity.id,
    request_opportunity_id: opportunity.id,
    content_fingerprint: context.sourceFingerprint,
    request_content_fingerprint: context.sourceFingerprint,
    input_fingerprint: context.extractionFingerprint,
    request_input_fingerprint: context.extractionFingerprint,
    feature: 'opportunity-extraction-chunk-1',
    request_feature: 'opportunity-extraction-chunk-1',
    profile: 'opportunity-intelligence-extraction',
    request_profile: 'opportunity-intelligence-extraction',
    model: 'openai/gpt-6-luna',
    request_model: 'openai/gpt-6-luna',
    prompt_version: REQUIREMENT_COVERAGE_EXTRACTION_PROMPT_VERSION,
    output_schema_version: REQUIREMENT_COVERAGE_EXTRACTION_SCHEMA_VERSION,
    prepared_payload_version: posting.version,
    status: 'completed',
    request_status: 'succeeded',
    accounting_basis: 'actual',
    actual_total_tokens: 1000,
    reserved_input_tokens: 6000,
    requested_max_output_tokens: 4096,
    reserved_spend_micros: 2648,
    tenant_id: '',
    owner_user_id: '',
    candidate_profile_id: '',
    request_tenant_id: '',
    request_owner_user_id: '',
    request_candidate_profile_id: '',
    agent_run_id: 'original-run',
    request_agent_run_id: 'original-run',
    run_tenant_id: subject.tenantId,
    run_owner_user_id: subject.userId,
    run_candidate_profile_id: subject.profileId,
    run_opportunity_id: opportunity.id,
    output_json: JSON.stringify({ requirementCoverage: ledger }),
  };
  const db = {
    query: vi.fn(async (_sql: string, _params: unknown[]) => ({ rows: [row] })),
  };
  return { opportunity, context, ledger, row, db };
}

function jobFixture(
  opportunity: Record<string, unknown>,
  intent: Record<string, unknown>,
) {
  // TaskRunner supplies plain durable job context. Its fields are never a Job instance.
  const context = {
    job: {
      jobId: 'job-1',
      attempt: 1,
      objectId: opportunity.id,
      objectType: '@willgriffin/iolaus-site:Opportunity',
      method: 'prepareAssessmentCoverage',
      queue: 'opportunity-intelligence',
      tenantId: subject.tenantId,
    },
  } as unknown as JobExecutionContext;
  runnerState.active = context;
  const job = {
    id: 'job-1',
    status: 'running',
    attempts: 1,
    ...context.job,
    args: {
      runtimeWorkspaceSubject: subject,
      contentFingerprint: opportunity.sourceContentFingerprint,
      contentVersion: opportunity.sourceContentVersion,
      sourceDependencyFingerprint: 'source-seed',
      sourceCoverageStage: intent,
    },
    save: vi.fn(async () => {}),
  } as unknown as SmrtJob;
  const run: PrincipalRun = {
    context: {} as PrincipalRun['context'],
    permissions: [],
    allowedTools: [],
    isToolAllowed: () => false,
    assertToolAllowed: () => {
      throw new Error('No tools.');
    },
    assertOperation: vi.fn(async () => undefined as never),
  };
  const runFreshSpy = vi.fn();
  const runFresh: NonNullable<Dependencies['runFresh']> = async <T>(
    resolvedSubject: typeof subject,
    capability: Parameters<NonNullable<Dependencies['runFresh']>>[1],
    work: (current: typeof subject, run: PrincipalRun) => Promise<T>,
  ): Promise<T> => {
    runFreshSpy(resolvedSubject, capability);
    return await work(resolvedSubject, run);
  };
  const deps = {
    getOpportunity: vi.fn(async () => opportunity),
    getJob: vi.fn(async () => job),
    assertNotAttempted: vi.fn(async () => {}),
    runFresh,
    requireOperator: vi.fn(),
    withLock: async <T>(_id: string, work: () => Promise<T>) => await work(),
    startRun: vi.fn(async () => 'new-run'),
    finishRun: vi.fn(async () => {}),
    extract: vi.fn(async () => ({
      status: 'processed',
      message: 'Saved unverified checkpoint.',
    })),
    audit: vi.fn(),
  };
  return { context, job, deps, runFreshSpy };
}
beforeEach(() => {
  // Admission intentionally fails closed without explicit operator limits.
  vi.stubEnv('OPPORTUNITY_INTELLIGENCE_RUN_CALL_LIMIT', '4');
  vi.stubEnv('OPPORTUNITY_INTELLIGENCE_RUN_INPUT_TOKEN_LIMIT', '80000');
  vi.stubEnv('OPPORTUNITY_INTELLIGENCE_RUN_SPEND_LIMIT_MICROS', '100000');
});
afterEach(() => vi.unstubAllEnvs());

describe('native staged source receipt attestation', () => {
  it('reconstructs output from exact native requestId and carries original lifecycle reservation', async () => {
    const f = fixture();
    f.opportunity.preparedPostingJson = JSON.stringify({
      requirementCoverage: { forged: true },
    });
    const result = await attestCompletedOpportunitySourceExtraction(
      f.opportunity,
      'native-request-1',
      f.db,
    );
    expect(result.output).toEqual(JSON.parse(String(f.row.output_json)));
    expect(result.reservation).toEqual({
      calls: 1,
      reservedTokens: 10096,
      spendMicros: 2648,
    });
    expect(result.agentRunId).toBe('original-run');
    // PostgreSQL AgentRun physical ids are UUID; request links are TEXT.
    expect(f.db.query.mock.calls[0][0]).toContain(
      'CAST(a.id AS TEXT) = CAST(q.agent_run_id AS TEXT)',
    );
    expect(f.db.query.mock.calls[0][1]).toEqual([
      'opportunity-1',
      'source-1',
      'native-request-1',
    ]);
    expect(result.ledger.audit).toBeUndefined();
  });
  it.each([
    ['owner_request_id', 'orphan'],
    ['result_request_id', 'physical-id'],
    ['request_idempotency_key', 'forged'],
    ['request_id', 'physical-row-id'],
    ['tenant_id', 'foreign'],
    ['request_candidate_profile_id', 'foreign'],
    ['status', 'failed'],
    ['request_status', 'failed'],
    ['accounting_basis', 'conservative'],
    ['actual_total_tokens', 0],
    ['input_fingerprint', 'stale'],
    ['prompt_version', 'old-contract'],
    ['output_schema_version', 'old-schema'],
    ['prepared_payload_version', 'old-prepared'],
    ['model', 'other'],
    ['request_model', 'other'],
    ['profile', 'other'],
    ['request_agent_run_id', 'orphan'],
    ['run_opportunity_id', 'foreign'],
  ])('denies forged/missing/nonactual metadata %s', async (key, value) => {
    const f = fixture();
    f.row[key] = value;
    await expect(
      attestCompletedOpportunitySourceExtraction(
        f.opportunity,
        'native-request-1',
        f.db,
      ),
    ).rejects.toThrow();
  });
  it('rejects stale raw/version input rather than trusting prepared cache', async () => {
    const f = fixture();
    f.opportunity.sourceContentVersion = 2;
    await expect(
      attestCompletedOpportunitySourceExtraction(
        f.opportunity,
        'native-request-1',
        f.db,
      ),
    ).rejects.toThrow();
  });
  it.each([
    'owned',
    'owned-v1',
    'zero-spend-forgery',
    'foreign',
    'global',
    'failed',
    'contract',
    'source-selector',
  ])('carries only authentic same-run PRIVATE screen reservation (%s) without GLOBAL authority', async (caseName) => {
    const f = fixture();
    const screen: Record<string, unknown> = {
      ...f.row,
      owner_request_id: 'screen-request',
      result_request_id: 'screen-request',
      request_id: 'screen-request',
      result_idempotency_key: 'screen-key',
      request_idempotency_key: 'screen-key',
      feature: 'opportunity-screening',
      request_feature: 'opportunity-screening',
      profile: 'typesafe-opportunity-screening',
      request_profile: 'typesafe-opportunity-screening',
      model: 'jev-test',
      request_model: 'jev-test',
      prompt_version: OPPORTUNITY_SCREENING_VERSION,
      output_schema_version: OPPORTUNITY_SCREENING_VERSION,
      prepared_payload_version: OPPORTUNITY_SCREENING_VERSION,
      input_fingerprint: 'b'.repeat(64),
      request_input_fingerprint: 'b'.repeat(64),
      tenant_id: subject.tenantId,
      request_tenant_id: subject.tenantId,
      owner_user_id: subject.userId,
      request_owner_user_id: subject.userId,
      candidate_profile_id: subject.profileId,
      request_candidate_profile_id: subject.profileId,
      reserved_input_tokens: 1000,
      requested_max_output_tokens: 800,
      reserved_spend_micros: 25,
      output_json: JSON.stringify({
        privateCandidatePreference: 'must-never-enter-public-source',
      }),
    };
    if (caseName === 'owned-v1') {
      screen.prompt_version = OPPORTUNITY_SCREENING_V1_VERSION;
      screen.output_schema_version = OPPORTUNITY_SCREENING_V1_VERSION;
      screen.prepared_payload_version = OPPORTUNITY_SCREENING_V1_VERSION;
    }
    if (caseName === 'zero-spend-forgery') screen.reserved_spend_micros = 0;
    if (caseName === 'foreign') screen.request_owner_user_id = 'foreign-owner';
    if (caseName === 'global') screen.tenant_id = screen.request_tenant_id = '';
    if (caseName === 'failed') screen.request_status = 'failed';
    if (caseName === 'contract')
      screen.output_schema_version = 'unrecognized-screen';
    const read = attestCompletedOpportunitySourceExtraction(
      f.opportunity,
      caseName === 'source-selector'
        ? String(screen.request_id)
        : 'native-request-1',
      { query: vi.fn(async () => ({ rows: [f.row, screen] })) },
    );
    if (caseName === 'owned' || caseName === 'owned-v1') {
      const attested = await read;
      expect(attested.reservation).toEqual({
        calls: 2,
        reservedTokens: 11896,
        spendMicros: 2673,
      });
      expect(attested.output).toEqual(JSON.parse(String(f.row.output_json)));
      expect(JSON.stringify(attested.ledger)).not.toContain(
        'must-never-enter-public-source',
      );
    } else await expect(read).rejects.toThrow();
    expect(processOpportunityWithLlm).not.toHaveBeenCalled();
  });
  it('carries full and evidence audit reservations in the same native lifecycle', async () => {
    const f = fixture();
    const rows = [
      f.row,
      ...[
        'opportunity-source-requirement-coverage',
        'opportunity-source-requirement-evidence',
      ].map((feature, index) => ({
        ...f.row,
        feature,
        request_feature: feature,
        model: 'jev-test',
        request_model: 'jev-test',
        profile: feature.endsWith('evidence')
          ? 'typesafe-opportunity-source-evidence'
          : 'typesafe-opportunity-source-coverage',
        request_profile: feature.endsWith('evidence')
          ? 'typesafe-opportunity-source-evidence'
          : 'typesafe-opportunity-source-coverage',
        owner_request_id: `audit-${index}`,
        request_id: `audit-${index}`,
        result_request_id: `audit-${index}`,
        result_idempotency_key: `audit-idempotency-${index}`,
        request_idempotency_key: `audit-idempotency-${index}`,
        input_fingerprint: `audit-input-${index}`,
        request_input_fingerprint: `audit-input-${index}`,
      })),
    ];
    const result = await attestCompletedOpportunitySourceExtraction(
      f.opportunity,
      'native-request-1',
      { query: vi.fn(async () => ({ rows })) },
    );
    expect(result.reservation).toEqual({
      calls: 3,
      reservedTokens: 30288,
      spendMicros: 7944,
    });
    expect(f.db.query.mock.calls).toHaveLength(0);
  });
  it.each([
    false,
    true,
  ])('pure exact evidence admission preserves historical caps (exhausted=%s)', async (exhausted) => {
    const f = fixture();
    const completed = await attestCompletedOpportunitySourceExtraction(
      f.opportunity,
      'native-request-1',
      f.db,
    );
    if (exhausted)
      completed.reservation = {
        calls: 3,
        reservedTokens: 79999,
        spendMicros: 99999,
      };
    const plan = preflightCompletedOpportunityRequirementEvidenceAudit(
      completed,
      {
        limits: { calls: 4, inputTokens: 80000, spendMicros: 100000 },
        auditPricing: {
          configured: true,
          inputMicrosPerMillion: 1,
          outputMicrosPerMillion: 1,
        },
      },
    );
    expect(plan.admitted).toBe(!exhausted);
    expect(plan.exact.calls).toBe(completed.reservation.calls + 1);
    expect(plan.exact.reservedTokens).toBe(
      completed.reservation.reservedTokens +
        plan.exact.requestBytes +
        plan.exact.maxOutputTokens,
    );
    expect(plan.preparedAudit.request.state).toEqual({});
    expect(Object.keys(plan.preparedAudit.request.questions)).toHaveLength(3);
  });
  it('never reattempts any prior exact native identity', async () => {
    const f = fixture();
    await expect(
      assertOpportunitySourceExtractionNotAttempted(f.opportunity, f.db),
    ).rejects.toThrow('already attempted');
  });
});

describe('native staged source job fences', () => {
  it('uses a separately loaded durable job with plain runner context and extraction-only source options', async () => {
    const f = fixture();
    const j = jobFixture(f.opportunity, {
      contract: SOURCE_COVERAGE_STAGE_JOB_CONTRACT,
      stage: 'extract',
    });
    await runOpportunityRequirementCoverageSourceStageJob(
      'opportunity-1',
      j.context,
      subject,
      j.deps,
    );
    expect(j.deps.getJob).toHaveBeenCalledWith('job-1');
    expect(j.job.save).toHaveBeenCalledOnce();
    expect(j.deps.extract).toHaveBeenCalledWith(
      'opportunity-1',
      expect.objectContaining({
        sourceExtractionStage: 'extract-only',
        agentRunId: 'new-run',
        assertCurrentAuthority: expect.any(Function),
      }),
    );
    expect(j.deps.audit).not.toHaveBeenCalled();
  });
  it.each([
    'source',
    'owner',
    'attempt',
    'revocation',
    'intent',
    'failed-identity',
  ])('denies %s before extraction transport', async (failure) => {
    const f = fixture();
    const j = jobFixture(f.opportunity, {
      contract: SOURCE_COVERAGE_STAGE_JOB_CONTRACT,
      stage: 'extract',
    });
    if (failure === 'source') j.job.args.contentVersion = 2;
    if (failure === 'owner')
      j.job.args.runtimeWorkspaceSubject = { ...subject, profileId: 'foreign' };
    if (failure === 'attempt') j.job.attempts = 2;
    if (failure === 'revocation')
      j.deps.requireOperator.mockImplementation(() => {
        throw new Error('Revoked.');
      });
    if (failure === 'intent')
      j.job.args.sourceCoverageStage = {
        contract: 'foreign',
        stage: 'extract',
      };
    if (failure === 'failed-identity')
      j.deps.assertNotAttempted.mockRejectedValue(new Error('Prior failure.'));
    await expect(
      runOpportunityRequirementCoverageSourceStageJob(
        'opportunity-1',
        j.context,
        subject,
        j.deps,
      ),
    ).rejects.toThrow();
    expect(j.deps.extract).not.toHaveBeenCalled();
    expect(j.deps.startRun).not.toHaveBeenCalled();
  });
  it.each([
    'error',
    'failed',
  ])('extraction %s fails the native job without repeating provider work', async (status) => {
    const f = fixture();
    const j = jobFixture(f.opportunity, {
      contract: SOURCE_COVERAGE_STAGE_JOB_CONTRACT,
      stage: 'extract',
    });
    j.deps.extract.mockResolvedValue({
      status,
      message: 'Recorded provider failure.',
    });
    await expect(
      runOpportunityRequirementCoverageSourceStageJob(
        'opportunity-1',
        j.context,
        subject,
        j.deps,
      ),
    ).rejects.toThrow('Recorded provider failure.');
    expect(j.deps.extract).toHaveBeenCalledOnce();
    expect(j.deps.finishRun).toHaveBeenCalledOnce();
    expect(j.deps.finishRun).toHaveBeenCalledWith(
      'new-run',
      'failed',
      'Recorded provider failure.',
      subject,
    );
    expect(j.deps.audit).not.toHaveBeenCalled();
  });
  it('stale extraction remains a distinct skipped result', async () => {
    const f = fixture();
    const j = jobFixture(f.opportunity, {
      contract: SOURCE_COVERAGE_STAGE_JOB_CONTRACT,
      stage: 'extract',
    });
    j.deps.extract.mockResolvedValue({
      status: 'skipped',
      message: 'Discarded stale source.',
    });
    await expect(
      runOpportunityRequirementCoverageSourceStageJob(
        'opportunity-1',
        j.context,
        subject,
        j.deps,
      ),
    ).resolves.toEqual({
      status: 'skipped',
      message: 'Discarded stale source.',
    });
    expect(j.deps.extract).toHaveBeenCalledOnce();
    expect(j.deps.audit).not.toHaveBeenCalled();
  });
  it('missing completed receipt never falls back to extraction', async () => {
    const f = fixture();
    const j = jobFixture(f.opportunity, {
      contract: SOURCE_COVERAGE_STAGE_JOB_CONTRACT,
      stage: 'audit_completed_extraction',
      extractionRequestId: 'missing',
    });
    await expect(
      runOpportunityRequirementCoverageSourceStageJob(
        'opportunity-1',
        j.context,
        subject,
        {
          ...j.deps,
          attest: vi.fn(async () => {
            throw new Error('Missing native receipt.');
          }),
        },
      ),
    ).rejects.toThrow('Missing native');
    expect(j.deps.extract).not.toHaveBeenCalled();
    expect(j.deps.audit).not.toHaveBeenCalled();
    expect(j.deps.startRun).not.toHaveBeenCalled();
  });
  it.each([
    false,
    true,
  ])('completed resume reuses original native run and fresh publication fence (revoked=%s)', async (revoked) => {
    const f = fixture();
    const completed = await attestCompletedOpportunitySourceExtraction(
      f.opportunity,
      'native-request-1',
      f.db,
    );
    f.opportunity.preparedPostingJson = JSON.stringify({
      retained: 'existing-history',
      requirementCoverage: completed.ledger,
    });
    const j = jobFixture(f.opportunity, {
      contract: SOURCE_COVERAGE_STAGE_JOB_CONTRACT,
      stage: 'audit_completed_extraction',
      extractionRequestId: completed.requestId,
      extractionInputFingerprint: completed.context.extractionFingerprint,
      ledgerFingerprint: completed.ledgerFingerprint,
    });
    vi.stubEnv('OPPORTUNITY_SKILL_DECISION_INPUT_COST_MICROS_PER_MILLION', '1');
    vi.stubEnv(
      'OPPORTUNITY_SKILL_DECISION_OUTPUT_COST_MICROS_PER_MILLION',
      '1',
    );
    const audit: typeof import('./opportunity-requirement-coverage-provider.js').evaluateRequirementCoverageAudit =
      vi.fn(async (prepared) => {
        const result = resolveRequirementCoverageAudit(
          prepared,
          {
            model: 'jev-test',
            provenance: { model: 'jev-test', provider: 'typesafe' },
            answers: Object.fromEntries(
              Object.keys(prepared.request.questions).map((key) => [
                key,
                { type: 'predicate', probability: 0.999 },
              ]),
            ),
          },
          'native-audit-request',
        );
        if (revoked)
          j.deps.requireOperator.mockImplementation(() => {
            throw new Error('Revoked before publication.');
          });
        return result;
      });
    const update = vi.fn(async () => true);
    const transaction = async <T>(
      work: (db: TransactionDatabase) => Promise<T>,
    ) => await work({} as TransactionDatabase);
    const promise = runOpportunityRequirementCoverageSourceStageJob(
      'opportunity-1',
      j.context,
      subject,
      {
        ...j.deps,
        attest: vi.fn(async () => completed),
        audit,
        update,
        transaction,
      },
    );
    if (revoked) {
      await expect(promise).rejects.toThrow('Revoked');
      expect(update).not.toHaveBeenCalled();
    } else {
      await expect(promise).resolves.toMatchObject({ status: 'processed' });
      expect(update).toHaveBeenCalledWith(
        'opportunity-1',
        'source-1',
        expect.objectContaining({
          preparedPostingFingerprint: completed.posting.fingerprint,
        }),
        1,
        expect.any(Object),
      );
    }
    expect(audit).toHaveBeenCalledOnce();
    expect(audit).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({ agentRunId: 'original-run' }),
    );
    expect(j.deps.startRun).not.toHaveBeenCalled();
    expect(j.deps.extract).not.toHaveBeenCalled();
  });
  it.each([
    'published',
    'partial',
    'revoked',
    'stale',
    'missing-native',
    'budget',
    'contract',
  ])('direct completed evidence audit enforces %s without Luna or full V6 audit', async (caseName) => {
    const f = fixture();
    const completed = await attestCompletedOpportunitySourceExtraction(
      f.opportunity,
      'native-request-1',
      f.db,
    );
    f.opportunity.preparedPostingJson = JSON.stringify({
      retained: 'history',
      requirementCoverage: completed.ledger,
    });
    const originalJson = f.opportunity.preparedPostingJson;
    if (caseName === 'budget')
      completed.reservation = {
        calls: 3,
        reservedTokens: 79999,
        spendMicros: 99999,
      };
    const j = jobFixture(f.opportunity, {
      contract: SOURCE_COVERAGE_STAGE_JOB_CONTRACT,
      stage: 'evidence_completed_extraction',
      auditContract:
        caseName === 'contract'
          ? 'old-evidence-contract'
          : REQUIREMENT_EVIDENCE_AUDIT_VERSION,
      extractionRequestId: completed.requestId,
      extractionInputFingerprint: completed.context.extractionFingerprint,
      ledgerFingerprint: completed.ledgerFingerprint,
    });
    vi.stubEnv('OPPORTUNITY_SKILL_DECISION_INPUT_COST_MICROS_PER_MILLION', '1');
    vi.stubEnv(
      'OPPORTUNITY_SKILL_DECISION_OUTPUT_COST_MICROS_PER_MILLION',
      '1',
    );
    let recorded:
      | ReturnType<typeof partialRequirementEvidenceFromAudit>
      | undefined;
    const evidenceAudit: typeof import('./opportunity-requirement-coverage-provider.js').evaluateRequirementEvidenceAudit =
      vi.fn(async (prepared: PreparedRequirementEvidenceAudit) => {
        const audit = resolveRequirementEvidenceAudit(
          prepared,
          {
            model: 'jev-test',
            provenance: { model: 'jev-test', provider: 'typesafe' },
            answers: Object.fromEntries(
              Object.entries(prepared.bindings).map(([key, binding]) => [
                key,
                {
                  type: 'predicate',
                  probability:
                    caseName === 'partial' && binding.mode === 'recall'
                      ? 0.1
                      : 0.999,
                },
              ]),
            ),
          },
          'native-evidence-request',
        );
        recorded = partialRequirementEvidenceFromAudit(prepared, audit);
        if (caseName === 'revoked')
          j.deps.requireOperator.mockImplementation(() => {
            throw new Error('Revoked after evidence provider.');
          });
        if (caseName === 'stale') f.opportunity.sourceContentVersion = 2;
        return audit;
      });
    const readEvidence = vi.fn(async () =>
      caseName === 'missing-native' ? undefined : recorded,
    );
    const update = vi.fn(
      async (_id: string, _fp: string, updates: Record<string, unknown>) => {
        Object.assign(f.opportunity, updates);
        return true;
      },
    );
    const transaction = async <T>(
      work: (db: TransactionDatabase) => Promise<T>,
    ) => await work({} as TransactionDatabase);
    const result = runOpportunityRequirementCoverageSourceStageJob(
      'opportunity-1',
      j.context,
      subject,
      {
        ...j.deps,
        attest: vi.fn(async () => completed),
        evidenceAudit,
        readEvidence,
        update,
        transaction,
      },
    );
    if (caseName === 'published' || caseName === 'partial') {
      await expect(result).resolves.toMatchObject({ status: 'processed' });
      expect(evidenceAudit).toHaveBeenCalledOnce();
      expect(readEvidence).toHaveBeenCalledOnce();
      expect(update).toHaveBeenCalledOnce();
      const saved = JSON.parse(String(f.opportunity.preparedPostingJson));
      expect(saved.retained).toBe('history');
      expect(saved.requirementCoverage.audit).toBeUndefined();
      expect(saved.requirementCoverageEvidenceAudit.fullCoverage).toBe(
        caseName === 'published',
      );
      if (caseName === 'partial') {
        expect(recorded?.acceptedRequirements).toHaveLength(1);
        expect(recorded?.unresolvedClauses).toHaveLength(1);
      }
    } else {
      await expect(result).rejects.toThrow();
      expect(update).not.toHaveBeenCalled();
      expect(f.opportunity.preparedPostingJson).toBe(originalJson);
      if (caseName === 'budget' || caseName === 'contract')
        expect(evidenceAudit).not.toHaveBeenCalled();
      else expect(evidenceAudit).toHaveBeenCalledOnce();
    }
    expect(j.deps.extract).not.toHaveBeenCalled();
    expect(j.deps.audit).not.toHaveBeenCalled();
    expect(j.deps.startRun).not.toHaveBeenCalled();
    if (caseName !== 'contract')
      expect(j.job.args.sourcePreparationAgentRunId).toBe('original-run');
  });
  it.each([
    'published',
    'missing-eligibility',
    'foreign-eligibility',
    'stale-eligibility-context',
    'budget',
  ])('explicit V3 native evidence enforces %s against the original lifecycle', async (caseName) => {
    const f = fixture('Requirements\nBuild reliable software in Canada.');
    const completed = await attestCompletedOpportunitySourceExtraction(
      f.opportunity,
      'native-request-1',
      f.db,
    );
    f.opportunity.preparedPostingJson = JSON.stringify({
      retained: 'original-checkpoint',
      requirementCoverage: completed.ledger,
    });
    const originalJson = f.opportunity.preparedPostingJson;
    if (caseName === 'budget')
      completed.reservation = {
        calls: 2,
        reservedTokens: 79999,
        spendMicros: 99999,
      };
    const j = jobFixture(f.opportunity, {
      contract: SOURCE_COVERAGE_STAGE_JOB_CONTRACT,
      stage: 'evidence_completed_extraction',
      auditContract: REQUIREMENT_EVIDENCE_ELIGIBILITY_AUDIT_VERSION,
      extractionRequestId: completed.requestId,
      extractionInputFingerprint: completed.context.extractionFingerprint,
      ledgerFingerprint: completed.ledgerFingerprint,
    });
    vi.stubEnv('OPPORTUNITY_SKILL_DECISION_INPUT_COST_MICROS_PER_MILLION', '1');
    vi.stubEnv(
      'OPPORTUNITY_SKILL_DECISION_OUTPUT_COST_MICROS_PER_MILLION',
      '1',
    );
    let recorded:
      | ReturnType<typeof partialRequirementEvidenceFromAudit>
      | undefined;
    const evidenceAudit: NonNullable<Dependencies['evidenceAudit']> = vi.fn(
      async (
        prepared: PreparedRequirementEvidenceAudit,
        options: Parameters<NonNullable<Dependencies['evidenceAudit']>>[1],
      ) => {
        expect(prepared.version).toBe(
          REQUIREMENT_EVIDENCE_ELIGIBILITY_AUDIT_VERSION,
        );
        expect(prepared.sourceEligibility).toBeDefined();
        expect(options.agentRunId).toBe('original-run');
        expect(options.historicalReservation).toEqual(completed.reservation);
        const answers: DecisionResult['answers'] = Object.fromEntries(
          Object.entries(prepared.request.questions).map(([key, question]) => [
            key,
            question.type === 'choice'
              ? {
                  type: 'choice',
                  choice: 'none',
                  confidence: 1,
                  probabilities: Object.fromEntries(
                    Object.keys(question.criteria).map((choice) => [
                      choice,
                      choice === 'none' ? 1 : 0,
                    ]),
                  ),
                }
              : {
                  type: 'predicate',
                  probability:
                    key.startsWith('source_eligibility__') &&
                    !key.startsWith('source_eligibility__coverage__')
                      ? 0.1
                      : 0.999,
                },
          ]),
        );
        const audit = resolveRequirementEvidenceAudit(
          prepared,
          {
            model: 'jev-test',
            provenance: { model: 'jev-test', provider: 'typesafe' },
            answers,
          },
          'native-v3-request',
        );
        recorded = partialRequirementEvidenceFromAudit(prepared, audit);
        return audit;
      },
    );
    const readEligibility: NonNullable<Dependencies['readEligibility']> = vi.fn(
      async () => {
        if (
          caseName === 'missing-eligibility' ||
          !recorded?.audit.sourceEligibility
        )
          return undefined;
        return {
          evidence: {
            ...recorded.audit.sourceEligibility,
            ...(caseName === 'foreign-eligibility'
              ? { requestId: 'foreign-request' }
              : {}),
          },
          sourceContext: {
            sourceText: completed.context.sourceText,
            sourceContentFingerprint: completed.context.sourceFingerprint,
            sourceContentVersion:
              caseName === 'stale-eligibility-context'
                ? 2
                : completed.context.sourceVersion,
          },
        };
      },
    );
    const update = vi.fn(
      async (_id: string, _fp: string, updates: Record<string, unknown>) => {
        Object.assign(f.opportunity, updates);
        return true;
      },
    );
    const result = runOpportunityRequirementCoverageSourceStageJob(
      'opportunity-1',
      j.context,
      subject,
      {
        ...j.deps,
        attest: vi.fn(async () => completed),
        evidenceAudit,
        readEvidence: vi.fn(async () => recorded),
        readEligibility,
        transaction: async <T>(work: (db: TransactionDatabase) => Promise<T>) =>
          await work({} as TransactionDatabase),
        update,
      },
    );
    if (caseName === 'published') {
      await expect(result).resolves.toMatchObject({ status: 'processed' });
      expect(readEligibility).toHaveBeenCalledOnce();
      expect(update).toHaveBeenCalledOnce();
      const saved = JSON.parse(String(f.opportunity.preparedPostingJson));
      expect(saved.retained).toBe('original-checkpoint');
      expect(saved.requirementCoverage.audit).toBeUndefined();
      expect(saved.requirementCoverageEvidenceAudit).toMatchObject({
        version: REQUIREMENT_EVIDENCE_ELIGIBILITY_AUDIT_VERSION,
        requestId: 'native-v3-request',
        sourceEligibility: {
          requestId: 'native-v3-request',
          sourceContentFingerprint: 'source-1',
          sourceContentVersion: 1,
        },
      });
    } else {
      await expect(result).rejects.toThrow();
      expect(update).not.toHaveBeenCalled();
      expect(f.opportunity.preparedPostingJson).toBe(originalJson);
    }
    if (caseName === 'budget') {
      expect(evidenceAudit).not.toHaveBeenCalled();
      expect(readEligibility).not.toHaveBeenCalled();
    } else expect(evidenceAudit).toHaveBeenCalledOnce();
    expect(j.deps.extract).not.toHaveBeenCalled();
    expect(j.deps.audit).not.toHaveBeenCalled();
    expect(j.deps.startRun).not.toHaveBeenCalled();
  });
  it('requires native captured source JSON for pure V4 admission while preserving V3 replay', async () => {
    const f = fixture();
    const completed = await attestCompletedOpportunitySourceExtraction(
      f.opportunity,
      'native-request-1',
      f.db,
    );
    const options = {
      auditPricing: {
        configured: true,
        inputMicrosPerMillion: 1,
        outputMicrosPerMillion: 1,
      },
      limits: { calls: 4, inputTokens: 80000, spendMicros: 100000 },
    };
    expect(() =>
      preflightCompletedOpportunityRequirementEvidenceAudit(completed, {
        ...options,
        auditContract: REQUIREMENT_EVIDENCE_CAPTURED_SOURCE_AUDIT_VERSION,
      }),
    ).toThrow('Captured source metadata');
    expect(
      preflightCompletedOpportunityRequirementEvidenceAudit(completed, {
        ...options,
        auditContract: REQUIREMENT_EVIDENCE_ELIGIBILITY_AUDIT_VERSION,
      }).admitted,
    ).toBe(true);
  });
  it.each([
    'published',
    'missing-captured-proof',
    'foreign-captured-fields',
    'changed-captured-source',
    'budget',
  ])('explicit V4 native captured-source evidence enforces %s without resetting extraction', async (caseName) => {
    const f = fixture('Requirements\nBuild reliable software.', {
      locationNotes: 'Canada',
      workMode: 'Remote',
    });
    const completed = await attestCompletedOpportunitySourceExtraction(
      f.opportunity,
      'native-request-1',
      f.db,
    );
    f.opportunity.preparedPostingJson = JSON.stringify({
      retained: 'paid-original',
      requirementCoverage: completed.ledger,
    });
    const originalJson = f.opportunity.preparedPostingJson;
    if (caseName === 'budget')
      completed.reservation = {
        calls: 2,
        reservedTokens: 79999,
        spendMicros: 99999,
      };
    const j = jobFixture(f.opportunity, {
      contract: SOURCE_COVERAGE_STAGE_JOB_CONTRACT,
      stage: 'evidence_completed_extraction',
      auditContract: REQUIREMENT_EVIDENCE_CAPTURED_SOURCE_AUDIT_VERSION,
      extractionRequestId: completed.requestId,
      extractionInputFingerprint: completed.context.extractionFingerprint,
      ledgerFingerprint: completed.ledgerFingerprint,
    });
    vi.stubEnv('OPPORTUNITY_SKILL_DECISION_INPUT_COST_MICROS_PER_MILLION', '1');
    vi.stubEnv(
      'OPPORTUNITY_SKILL_DECISION_OUTPUT_COST_MICROS_PER_MILLION',
      '1',
    );
    let recorded:
      | ReturnType<typeof partialRequirementEvidenceFromAudit>
      | undefined;
    let capturedContext: SourceEligibilityEvidenceContext | undefined;
    const invokeAfterAttestation = vi.fn();
    const evidenceAudit: NonNullable<Dependencies['evidenceAudit']> = vi.fn(
      async (
        prepared: PreparedRequirementEvidenceAudit,
        options: Parameters<NonNullable<Dependencies['evidenceAudit']>>[1],
      ) => {
        expect(prepared.version).toBe(
          REQUIREMENT_EVIDENCE_CAPTURED_SOURCE_AUDIT_VERSION,
        );
        expect(prepared.ledgerFingerprint).toBe(completed.ledgerFingerprint);
        expect(prepared.capturedSource?.extractionRequestId).toBe(
          completed.requestId,
        );
        expect(prepared.capturedSource?.sourceContentJson).toBe(
          completed.sourceContentJson,
        );
        expect(options.agentRunId).toBe('original-run');
        expect(options.historicalReservation).toEqual(completed.reservation);
        if (caseName === 'changed-captured-source')
          f.opportunity.sourceContentJson = JSON.stringify({
            ...JSON.parse(String(f.opportunity.sourceContentJson)),
            locationNotes: 'United States',
          });
        const reattested = await options.resolveCompletedExtraction?.();
        expect(reattested).toMatchObject({
          requestId: completed.requestId,
          agentRunId: 'original-run',
          ledgerFingerprint: completed.ledgerFingerprint,
          sourceContentJson: completed.sourceContentJson,
          reservation: completed.reservation,
        });
        invokeAfterAttestation();
        capturedContext = prepared.sourceEligibility?.context;
        const answers: DecisionResult['answers'] = Object.fromEntries(
          Object.entries(prepared.request.questions).map(([key, question]) => [
            key,
            question.type === 'choice'
              ? {
                  type: 'choice',
                  choice: 'none',
                  confidence: 1,
                  probabilities: Object.fromEntries(
                    Object.keys(question.criteria).map((choice) => [
                      choice,
                      choice === 'none' ? 1 : 0,
                    ]),
                  ),
                }
              : {
                  type: 'predicate',
                  probability:
                    key.startsWith('source_eligibility__') &&
                    !key.startsWith('source_eligibility__coverage__')
                      ? 0.1
                      : 0.999,
                },
          ]),
        );
        const audit = resolveRequirementEvidenceAudit(
          prepared,
          {
            model: 'jev-test',
            provenance: { model: 'jev-test', provider: 'typesafe' },
            answers,
          },
          'native-v4-request',
        );
        recorded = partialRequirementEvidenceFromAudit(prepared, audit);
        return audit;
      },
    );
    const readEligibility: NonNullable<Dependencies['readEligibility']> = vi.fn(
      async () => {
        if (
          caseName === 'missing-captured-proof' ||
          !recorded?.audit.sourceEligibility ||
          !capturedContext
        )
          return undefined;
        return {
          evidence: recorded.audit.sourceEligibility,
          sourceContext: {
            ...capturedContext,
            ...(caseName === 'foreign-captured-fields'
              ? { capturedFieldsFingerprint: 'foreign-captured-fields' }
              : {}),
          },
        };
      },
    );
    const update = vi.fn(
      async (_id: string, _fp: string, updates: Record<string, unknown>) => {
        Object.assign(f.opportunity, updates);
        return true;
      },
    );
    const attest: NonNullable<Dependencies['attest']> = vi.fn(
      async (native: Parameters<NonNullable<Dependencies['attest']>>[0]) =>
        caseName === 'budget'
          ? completed
          : await attestCompletedOpportunitySourceExtraction(
              native,
              completed.requestId,
              f.db,
            ),
    );
    const result = runOpportunityRequirementCoverageSourceStageJob(
      'opportunity-1',
      j.context,
      subject,
      {
        ...j.deps,
        attest,
        evidenceAudit,
        readEvidence: vi.fn(async () => recorded),
        readEligibility,
        transaction: async <T>(work: (db: TransactionDatabase) => Promise<T>) =>
          await work({} as TransactionDatabase),
        update,
      },
    );
    if (caseName === 'published') {
      await expect(result).resolves.toMatchObject({ status: 'processed' });
      expect(readEligibility).toHaveBeenCalledOnce();
      expect(update).toHaveBeenCalledOnce();
      expect(
        capturedContext?.capturedFields?.map((field) => field.path),
      ).toEqual([
        'sourceContentJson.locationNotes',
        'sourceContentJson.workMode',
      ]);
      expect(capturedContext?.sourceText).toBe(completed.context.sourceText);
      expect(
        JSON.parse(String(f.opportunity.preparedPostingJson)),
      ).toMatchObject({
        retained: 'paid-original',
        requirementCoverageEvidenceAudit: {
          version: REQUIREMENT_EVIDENCE_CAPTURED_SOURCE_AUDIT_VERSION,
          requestId: 'native-v4-request',
          capturedSource: { extractionRequestId: completed.requestId },
        },
      });
    } else {
      await expect(result).rejects.toThrow();
      expect(update).not.toHaveBeenCalled();
      expect(f.opportunity.preparedPostingJson).toBe(originalJson);
    }
    if (caseName === 'budget') expect(evidenceAudit).not.toHaveBeenCalled();
    if (caseName === 'budget' || caseName === 'changed-captured-source')
      expect(invokeAfterAttestation).not.toHaveBeenCalled();
    else expect(invokeAfterAttestation).toHaveBeenCalledOnce();
    expect(j.deps.extract).not.toHaveBeenCalled();
    expect(j.deps.audit).not.toHaveBeenCalled();
    expect(j.deps.startRun).not.toHaveBeenCalled();
  });
  it('persists a video finding only from the attested composite GLOBAL receipt', async () => {
    const f = fixture(
      'Requirements\nBuild reliable software. You must submit a recorded video introduction with your application.',
    );
    const completed = await attestCompletedOpportunitySourceExtraction(
      f.opportunity,
      'native-request-1',
      f.db,
    );
    f.opportunity.preparedPostingJson = JSON.stringify({
      requirementCoverage: completed.ledger,
    });
    const j = jobFixture(f.opportunity, {
      contract: SOURCE_COVERAGE_STAGE_JOB_CONTRACT,
      stage: 'evidence_completed_extraction',
      auditContract: REQUIREMENT_EVIDENCE_AUDIT_VERSION,
      extractionRequestId: completed.requestId,
      extractionInputFingerprint: completed.context.extractionFingerprint,
      ledgerFingerprint: completed.ledgerFingerprint,
    });
    vi.stubEnv('OPPORTUNITY_SKILL_DECISION_INPUT_COST_MICROS_PER_MILLION', '1');
    vi.stubEnv(
      'OPPORTUNITY_SKILL_DECISION_OUTPUT_COST_MICROS_PER_MILLION',
      '1',
    );
    let recorded:
      | ReturnType<typeof partialRequirementEvidenceFromAudit>
      | undefined;
    const evidenceAudit: typeof import('./opportunity-requirement-coverage-provider.js').evaluateRequirementEvidenceAudit =
      vi.fn(async (prepared: PreparedRequirementEvidenceAudit) => {
        expect(prepared.video?.keys).toBeDefined();
        const answers: Record<string, unknown> = Object.fromEntries(
          Object.entries(prepared.bindings).map(([key]) => [
            key,
            { type: 'predicate', probability: 0.999 },
          ]),
        );
        const recordingClause = prepared.video?.prepared.clauses.find(
          (clause) => clause.quote.includes('recorded video introduction'),
        );
        if (!recordingClause)
          throw new Error('Expected exact nominated recording clause.');
        expect(
          prepared.video?.prepared.sourceText.slice(
            recordingClause.spanStart,
            recordingClause.spanEnd,
          ),
        ).toBe(recordingClause.quote);
        for (const [aggregate, leaf] of Object.entries(
          prepared.video?.keys ?? {},
        )) {
          const isRequiredRecording =
            leaf === 'recorded_application_video_required';
          const isRequiredRecordingEvidence =
            leaf === 'recorded_application_video_required_evidence';
          answers[aggregate] = leaf.endsWith('_evidence')
            ? {
                type: 'choice',
                choice: isRequiredRecordingEvidence
                  ? recordingClause.id
                  : 'none',
                confidence: 0.999,
              }
            : {
                type: 'predicate',
                probability: isRequiredRecording ? 0.999 : 0.1,
              };
        }
        const audit = resolveRequirementEvidenceAudit(
          prepared,
          {
            model: 'jev-test',
            provenance: { model: 'jev-test', provider: 'typesafe' },
            answers: answers as DecisionResult['answers'],
          },
          'native-evidence-request',
        );
        recorded = partialRequirementEvidenceFromAudit(prepared, audit);
        return audit;
      });
    const update = vi.fn(
      async (_id: string, _fp: string, updates: Record<string, unknown>) => {
        Object.assign(f.opportunity, updates);
        return true;
      },
    );
    const result = await runOpportunityRequirementCoverageSourceStageJob(
      'opportunity-1',
      j.context,
      subject,
      {
        ...j.deps,
        attest: vi.fn(async () => completed),
        evidenceAudit,
        readEvidence: vi.fn(async () => recorded),
        transaction: async <T>(work: (db: TransactionDatabase) => Promise<T>) =>
          await work({} as TransactionDatabase),
        update,
      },
    );

    expect(result).toMatchObject({ status: 'processed' });
    expect(evidenceAudit).toHaveBeenCalledOnce();
    const saved = JSON.parse(String(f.opportunity.preparedPostingJson));
    expect(saved.opportunityVideoRequirements).toMatchObject({
      requestId: 'native-evidence-request',
      compositeInputFingerprint: expect.any(String),
      sourceContentFingerprint: 'source-1',
      sourceContentVersion: 1,
      videoRequirements: {
        recordedSubmission: { status: 'required' },
        liveInterview: { status: 'unknown' },
      },
    });
  });
  it('excess historical reservation retains unverified checkpoint, reuses original run and makes zero provider calls', async () => {
    const f = fixture();
    const completed = await attestCompletedOpportunitySourceExtraction(
      f.opportunity,
      'native-request-1',
      f.db,
    );
    completed.reservation = {
      calls: 4,
      reservedTokens: 79999,
      spendMicros: 99000,
    };
    const initial = JSON.stringify({ requirementCoverage: completed.ledger });
    f.opportunity.preparedPostingJson = initial;
    const j = jobFixture(f.opportunity, {
      contract: SOURCE_COVERAGE_STAGE_JOB_CONTRACT,
      stage: 'audit_completed_extraction',
      extractionRequestId: completed.requestId,
      extractionInputFingerprint: completed.context.extractionFingerprint,
      ledgerFingerprint: requirementCoverageLedgerFingerprint(completed.ledger),
    });
    vi.stubEnv('OPPORTUNITY_SKILL_DECISION_INPUT_COST_MICROS_PER_MILLION', '1');
    vi.stubEnv(
      'OPPORTUNITY_SKILL_DECISION_OUTPUT_COST_MICROS_PER_MILLION',
      '1',
    );
    await expect(
      runOpportunityRequirementCoverageSourceStageJob(
        'opportunity-1',
        j.context,
        subject,
        { ...j.deps, attest: vi.fn(async () => completed) },
      ),
    ).rejects.toThrow('checkpoint retained');
    expect(j.deps.startRun).not.toHaveBeenCalled();
    expect(j.deps.extract).not.toHaveBeenCalled();
    expect(j.deps.audit).not.toHaveBeenCalled();
    expect(j.job.args.sourcePreparationAgentRunId).toBe('original-run');
    expect(f.opportunity.preparedPostingJson).toBe(initial);
  });
});
