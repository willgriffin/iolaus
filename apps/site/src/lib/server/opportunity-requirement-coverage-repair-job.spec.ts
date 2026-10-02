import type { PrincipalRun } from '@happyvertical/smrt-agents';
import type { JobExecutionContext, SmrtJob } from '@happyvertical/smrt-jobs';
import { describe, expect, it, vi } from 'vitest';
import { prepareOpportunityPosting } from './opportunity-posting-preparation.js';
import {
  buildRequirementCoverageSource,
  REQUIREMENT_COVERAGE_PAID_V4_PROMPT_VERSION,
  REQUIREMENT_COVERAGE_PAID_V4_SCHEMA_VERSION,
  REQUIREMENT_COVERAGE_REPAIR_VERSION,
  requirementCoverageContextForOpportunity,
} from './opportunity-requirement-coverage.js';
import {
  attestCompletedOpportunityRequirementCoverageRepair,
  attestOpportunityRequirementCoverageRepair,
  runOpportunityRequirementCoverageRepairJob,
  SOURCE_COVERAGE_REPAIR_JOB_CONTRACT,
} from './opportunity-requirement-coverage-repair-job.js';
import { opportunityWithSourceContent } from './opportunity-source-content.js';

const runnerState = vi.hoisted(() => ({ active: undefined as unknown }));
vi.mock('./db.js', () => ({
  getDbConfig: () => ({ type: 'sqlite', url: ':memory:' }),
  getSmrtOptions: () => ({}),
}));
vi.mock('./application-workflow.js', () => ({
  runOpportunityLifecycleTransaction: vi.fn(),
  withOpportunityLifecycleLock: vi.fn(),
}));
vi.mock('./opportunity-details.js', () => ({
  defaultFencedOpportunityUpdate: vi.fn(),
}));
vi.mock('./opportunity-intelligence-governance.js', () => ({
  startOpportunityIntelligenceAgentRun: vi.fn(),
  finishOpportunityIntelligenceAgentRun: vi.fn(),
}));
vi.mock('./smrt.js', () => ({ getCollection: vi.fn() }));
vi.mock('./source-crawl-operator.js', () => ({
  requireSourceCrawlOperator: vi.fn(),
}));
vi.mock(
  './opportunity-requirement-coverage-provider.js',
  async (importOriginal) => ({
    ...(await importOriginal<
      typeof import('./opportunity-requirement-coverage-provider.js')
    >()),
    requirementCoverageSourceDependencyFingerprint: () =>
      'source-dependency-seed',
  }),
);
// Runner branding itself belongs to native TaskRunner integration. This unit
// adapter only admits the separately established active test context.
vi.mock('./job-workspace-subject.js', () => ({
  requireActiveRunnerExecutionContext: (context: unknown) => {
    if (context !== runnerState.active)
      throw new Error('Not an active runner context.');
    return context;
  },
  runtimeWorkspaceSubjectFromJobArgs: (args: Record<string, unknown>) =>
    args.runtimeWorkspaceSubject,
  runAsRevalidatedJobWorkspaceSubject: vi.fn(),
}));

function fixture() {
  const opportunity: Record<string, unknown> = {
    id: 'opportunity-1',
    title: 'Fictional source repair role',
    descriptionRaw: [
      'Requirements',
      ...Array.from(
        { length: 42 },
        (_, index) =>
          `Candidate criterion ${index + 1} requires exact literal skill ${index + 1}.`,
      ),
    ].join('\n'),
    sourceContentFingerprint: 'current-source',
    sourceContentVersion: 1,
  };
  opportunity.preparedPostingFingerprint = prepareOpportunityPosting(
    opportunityWithSourceContent(opportunity),
  ).fingerprint;
  const context = requirementCoverageContextForOpportunity(
    opportunity,
    'paid-v4-coverage-only4096',
  );
  const base = buildRequirementCoverageSource(context);
  const answers: Record<string, unknown> = {};
  for (const [index, clause] of base.clauses.entries()) {
    if (clause.kind === 'heading') continue;
    const pending = index % 3 === 0;
    const id = `requirement-${index}`;
    if (!pending)
      base.requirements.push({
        id,
        text: clause.text,
        clauseIds: [clause.id],
        importance: 'unknown',
      });
    base.dispositions = base.dispositions.map((row) =>
      row.clauseId === clause.id
        ? {
            clauseId: clause.id,
            type: 'role_context',
            requirementIds: pending ? [] : [id],
          }
        : row,
    );
    answers[
      `c${index}_${pending ? 'contains_no_material_criterion' : 'mapping_retains_all_material_meaning'}`
    ] = {
      type: 'predicate',
      probability: index === 3 ? 0.2 : 0.99,
    };
  }
  const common = {
    opportunity_id: opportunity.id,
    request_opportunity_id: opportunity.id,
    content_fingerprint: context.sourceFingerprint,
    request_content_fingerprint: context.sourceFingerprint,
    status: 'completed',
    request_status: 'succeeded',
    accounting_basis: 'actual',
    actual_total_tokens: 1200,
    reserved_input_tokens: 6000,
    requested_max_output_tokens: 4096,
    reserved_spend_micros: 1000,
    tenant_id: '',
    owner_user_id: '',
    candidate_profile_id: '',
    request_tenant_id: '',
    request_owner_user_id: '',
    request_candidate_profile_id: '',
  };
  const baseReceipt: Record<string, unknown> = {
    ...common,
    owner_request_id: 'base-native-request',
    request_id: 'base-native-request',
    input_fingerprint: context.extractionFingerprint,
    request_input_fingerprint: context.extractionFingerprint,
    feature: 'opportunity-extraction-chunk-1',
    request_feature: 'opportunity-extraction-chunk-1',
    prompt_version: REQUIREMENT_COVERAGE_PAID_V4_PROMPT_VERSION,
    output_schema_version: REQUIREMENT_COVERAGE_PAID_V4_SCHEMA_VERSION,
    output_json: JSON.stringify({ requirementCoverage: base }),
  };
  const feedbackReceipt: Record<string, unknown> = {
    ...common,
    owner_request_id: 'audit-native-request',
    request_id: 'audit-native-request',
    input_fingerprint: 'pinned-historical-audit-input',
    request_input_fingerprint: 'pinned-historical-audit-input',
    feature: 'opportunity-source-requirement-coverage',
    request_feature: 'opportunity-source-requirement-coverage',
    prompt_version: 'requirement-coverage-audit/v4-keyed-binding',
    output_schema_version: 'requirement-coverage-audit/v4-keyed-binding',
    output_json: JSON.stringify({ answers }),
  };
  const selection = {
    baseRequestId: 'base-native-request',
    feedbackRequestId: 'audit-native-request',
    feedbackInputFingerprint: 'pinned-historical-audit-input',
    targetClauseIds: [base.clauses[3].id],
  };
  const db = {
    query: vi.fn(async (_sql: string, _params: unknown[]) => ({
      rows: [baseReceipt, feedbackReceipt],
    })),
  };
  return {
    opportunity,
    context,
    base,
    answers,
    baseReceipt,
    feedbackReceipt,
    selection,
    db,
  };
}

async function completedFixture() {
  const f = fixture();
  const base = await attestOpportunityRequirementCoverageRepair(
    f.opportunity,
    f.selection,
    f.db,
  );
  const target = base.prepared.base.clauses.find(
    (row) => row.id === f.selection.targetClauseIds[0],
  );
  if (!target) throw new Error('Fixture target missing.');
  const output = {
    requirementCoverage: {
      requirements: [
        {
          id: 'repair_r0',
          text: target.text,
          clauseIds: [target.id],
          importance: 'unknown',
        },
      ],
      dispositions: [
        {
          clauseId: target.id,
          type: 'material_requirement',
          requirementIds: ['repair_r0'],
        },
      ],
      removedRequirementIds: [],
    },
  };
  const repairReceipt: Record<string, unknown> = {
    ...f.baseReceipt,
    owner_request_id: 'completed-repair-request',
    request_id: 'completed-repair-request',
    input_fingerprint: base.prepared.provenance.inputFingerprint,
    request_input_fingerprint: base.prepared.provenance.inputFingerprint,
    feature: 'opportunity-source-requirement-repair',
    request_feature: 'opportunity-source-requirement-repair',
    prompt_version: REQUIREMENT_COVERAGE_REPAIR_VERSION,
    output_schema_version: REQUIREMENT_COVERAGE_REPAIR_VERSION,
    model: 'openai/gpt-6-luna',
    request_model: 'openai/gpt-6-luna',
    output_json: JSON.stringify(output),
  };
  f.db.query.mockImplementation(async (_sql, params) => ({
    rows: params.includes('completed-repair-request')
      ? [repairReceipt]
      : [f.baseReceipt, f.feedbackReceipt],
  }));
  return {
    ...f,
    selection: { ...f.selection, repairRequestId: 'completed-repair-request' },
    repairReceipt,
    output,
  };
}

describe('completed-only native source repair audit replay', () => {
  it('attests actual completed repair output and reconstructs the merged material instead of the posting payload', async () => {
    const f = await completedFixture();
    f.opportunity.preparedPostingJson = JSON.stringify({
      requirementCoverage: { requirements: [{ id: 'forged' }] },
    });
    const result = await attestCompletedOpportunityRequirementCoverageRepair(
      f.opportunity,
      f.selection,
      f.db,
    );
    expect(result.completedRepair).toMatchObject({
      requestId: 'completed-repair-request',
      output: f.output,
      inputFingerprint: result.prepared.provenance.inputFingerprint,
      contentFingerprint: f.context.sourceFingerprint,
      contentVersion: 1,
      reservation: { calls: 1, reservedTokens: 10096, spendMicros: 1000 },
    });
    expect(result.completedRepair.ledgerFingerprint).toMatch(/^[a-f0-9]{64}$/);
  });

  it.each([
    ['status', 'failed'],
    ['request_status', 'failed'],
    ['tenant_id', 'other'],
    ['request_candidate_profile_id', 'private-profile'],
    ['input_fingerprint', 'wrong-ancestry'],
    ['content_fingerprint', 'old-source'],
    ['output_schema_version', 'unknown'],
    ['accounting_basis', 'conservative'],
    ['actual_total_tokens', 0],
    ['model', 'other-model'],
  ] satisfies Array<
    [string, unknown]
  >)('rejects unauthoritative completed repair %s', async (key, value) => {
    const f = await completedFixture();
    f.repairReceipt[key] = value;
    await expect(
      attestCompletedOpportunityRequirementCoverageRepair(
        f.opportunity,
        f.selection,
        f.db,
      ),
    ).rejects.toThrow();
  });

  it('rejects an incomplete actual repair output without regenerating a replacement', async () => {
    const f = await completedFixture();
    f.repairReceipt.output_json = '{}';
    await expect(
      attestCompletedOpportunityRequirementCoverageRepair(
        f.opportunity,
        f.selection,
        f.db,
      ),
    ).rejects.toThrow();
  });

  it('rejects changed source despite a provided old completed ledger', async () => {
    const f = await completedFixture();
    f.opportunity.sourceContentVersion = 2;
    f.opportunity.preparedPostingJson = JSON.stringify({
      requirementCoverage: f.base,
    });
    await expect(
      attestCompletedOpportunityRequirementCoverageRepair(
        f.opportunity,
        f.selection,
        f.db,
      ),
    ).rejects.toThrow();
  });
});

describe('native source coverage repair attestation', () => {
  it('replays only actual GLOBAL receipts and decodes all 42 historical body questions', async () => {
    const f = fixture();
    const result = await attestOpportunityRequirementCoverageRepair(
      f.opportunity,
      f.selection,
      f.db,
    );
    expect(
      result.prepared.base.clauses.filter((clause) => clause.kind === 'body'),
    ).toHaveLength(42);
    expect(result.prepared.provenance).toMatchObject({
      baseRequestId: 'base-native-request',
      feedbackRequestId: 'audit-native-request',
      feedbackAuditFingerprint: 'pinned-historical-audit-input',
      targetClauseIds: f.selection.targetClauseIds,
      inputTokenCeiling: 6000,
      maxOutputTokens: 4096,
    });
    expect(result.feedbackAuthority).toBe(
      'native-persisted-historical-request-identity',
    );
    expect(result.baseReservation).toEqual({
      calls: 1,
      reservedTokens: 10096,
      spendMicros: 1000,
    });
    expect(result.feedbackReservation).toEqual({
      calls: 1,
      reservedTokens: 10096,
      spendMicros: 1000,
    });
    expect(f.db.query).toHaveBeenCalledWith(
      expect.stringContaining('JOIN opportunity_intelligence_requests'),
      ['base-native-request', 'audit-native-request', 'opportunity-1'],
    );
  });

  it('uses explicit paid V4 native ancestry while fresh extraction remains distinct and posting payload cannot select the contract', async () => {
    const f = fixture();
    const fresh = requirementCoverageContextForOpportunity(f.opportunity);
    expect(fresh.extractionFingerprint).not.toBe(
      f.context.extractionFingerprint,
    );
    f.opportunity.preparedPostingJson = JSON.stringify({
      requirementCoverage: {
        ...f.base,
        extractionFingerprint: fresh.extractionFingerprint,
      },
      extractionContract: 'current',
    });
    const result = await attestOpportunityRequirementCoverageRepair(
      f.opportunity,
      f.selection,
      f.db,
    );
    expect(result.prepared.context.extractionFingerprint).toBe(
      f.context.extractionFingerprint,
    );
    expect(result.prepared.provenance.baseRequestId).toBe(
      'base-native-request',
    );
  });

  it.each([
    ['tenant_id', 'foreign-tenant'],
    ['request_owner_user_id', 'user'],
    ['candidate_profile_id', 'profile'],
    ['opportunity_id', 'other-opportunity'],
    ['request_content_fingerprint', 'old-source'],
    ['input_fingerprint', 'forged-input'],
    ['output_schema_version', 'unknown-schema'],
    ['prompt_version', 'unknown-prompt'],
    ['status', 'failed'],
    ['request_status', 'failed'],
    ['accounting_basis', 'conservative'],
    ['actual_total_tokens', 0],
    ['request_id', 'forged-request'],
  ] satisfies Array<
    [string, unknown]
  >)('rejects a forged or nonauthoritative base %s', async (key, value) => {
    const f = fixture();
    f.baseReceipt[key] = value;
    await expect(
      attestOpportunityRequirementCoverageRepair(
        f.opportunity,
        f.selection,
        f.db,
      ),
    ).rejects.toThrow();
  });

  it.each([
    ['request_input_fingerprint', 'unbound-audit'],
    ['output_schema_version', 'current-v5-is-not-old-v4'],
    ['request_tenant_id', 'foreign-tenant'],
    ['accounting_basis', 'missing'],
    ['status', 'failed'],
  ] satisfies Array<
    [string, unknown]
  >)('rejects unbound historical feedback %s', async (key, value) => {
    const f = fixture();
    f.feedbackReceipt[key] = value;
    await expect(
      attestOpportunityRequirementCoverageRepair(
        f.opportunity,
        f.selection,
        f.db,
      ),
    ).rejects.toThrow();
  });

  it('rejects changed current source even when a forged prepared payload names the old ledger', async () => {
    const f = fixture();
    f.opportunity.sourceContentVersion = 2;
    f.opportunity.preparedPostingJson = JSON.stringify({
      requirementCoverage: f.base,
    });
    await expect(
      attestOpportunityRequirementCoverageRepair(
        f.opportunity,
        f.selection,
        f.db,
      ),
    ).rejects.toThrow();
  });

  it('rejects stale canonical prepared identity before loading receipts', async () => {
    const f = fixture();
    f.opportunity.preparedPostingFingerprint = 'stale-prepared';
    await expect(
      attestOpportunityRequirementCoverageRepair(
        f.opportunity,
        f.selection,
        f.db,
      ),
    ).rejects.toThrow();
    expect(f.db.query).not.toHaveBeenCalled();
  });

  it.each([
    'missing',
    'malformed',
    'wrong-key',
  ])('rejects %s historical body probability', async (mode) => {
    const f = fixture();
    const key = 'c3_contains_no_material_criterion';
    if (mode === 'malformed')
      f.answers[key] = { type: 'predicate', probability: 2 };
    else delete f.answers[key];
    if (mode === 'wrong-key')
      f.answers.c3_contains_no_candidate_criterion = {
        type: 'predicate',
        probability: 0.2,
      };
    f.feedbackReceipt.output_json = JSON.stringify({ answers: f.answers });
    await expect(
      attestOpportunityRequirementCoverageRepair(
        f.opportunity,
        f.selection,
        f.db,
      ),
    ).rejects.toThrow();
  });

  it('rejects missing or duplicate native records rather than accepting the caller artifact', async () => {
    const f = fixture();
    f.db.query.mockResolvedValue({
      rows: [f.baseReceipt, f.baseReceipt, f.feedbackReceipt],
    });
    await expect(
      attestOpportunityRequirementCoverageRepair(
        f.opportunity,
        f.selection,
        f.db,
      ),
    ).rejects.toThrow();
  });
});

describe('fresh native source repair adapter fences', () => {
  async function adapterFixture() {
    const f = fixture();
    const attested = await attestOpportunityRequirementCoverageRepair(
      f.opportunity,
      f.selection,
      f.db,
    );
    const subject = {
      tenantId: 'tenant-a',
      userId: 'operator-a',
      profileId: 'profile-a',
    };
    const context = {
      job: {
        jobId: 'native-job',
        attempt: 1,
        queue: 'opportunity-intelligence',
        objectType: '@willgriffin/iolaus-site:Opportunity',
        method: 'prepareAssessmentCoverage',
        tenantId: subject.tenantId,
      },
    } as JobExecutionContext;
    runnerState.active = context;
    const job = {
      ...context.job,
      id: 'native-job',
      objectId: 'opportunity-1',
      status: 'running',
      attempts: 1,
      args: {
        runtimeWorkspaceSubject: subject,
        contentFingerprint: f.context.sourceFingerprint,
        contentVersion: 1,
        sourceDependencyFingerprint: 'source-dependency-seed',
        repairInputFingerprint: attested.prepared.provenance.inputFingerprint,
        sourceCoverageRepair: {
          contract: SOURCE_COVERAGE_REPAIR_JOB_CONTRACT,
          ...f.selection,
        },
      },
      save: vi.fn(async () => {}),
    } as unknown as SmrtJob;
    const assertOperation = vi.fn(async () => undefined as never);
    const run: PrincipalRun = {
      context: {} as PrincipalRun['context'],
      permissions: [],
      allowedTools: [],
      isToolAllowed: () => false,
      assertToolAllowed: () => {
        throw new Error('No tools.');
      },
      assertOperation,
    };
    let revoked = false;
    let transactionActive = false;
    type Dependencies = Parameters<
      typeof runOpportunityRequirementCoverageRepairJob
    >[3];
    type TransactionDatabase = Parameters<
      Parameters<NonNullable<Dependencies['transaction']>>[0]
    >[0];
    // Test-only executor identity; the callback only forwards this exact handle.
    const pinnedDatabase = {} as TransactionDatabase;
    const dependencies: Dependencies = {
      getOpportunity: vi.fn(async () => f.opportunity),
      getJob: vi.fn(async () => job),
      attest: vi.fn(async () => attested),
      requireOperator: vi.fn(() => {}),
      runFresh: async <T>(
        _subject: typeof subject,
        capability: Parameters<NonNullable<Dependencies['runFresh']>>[1],
        work: (
          resolvedSubject: typeof subject,
          run: PrincipalRun,
        ) => Promise<T>,
      ): Promise<T> => {
        expect(capability).toBe('audit.record');
        if (revoked) throw new Error('Operator role revoked.');
        return await work(subject, run);
      },
      withLock: async <T>(_id: string, work: () => Promise<T>) => await work(),
      transaction: async <T>(work: (db: TransactionDatabase) => Promise<T>) => {
        transactionActive = true;
        try {
          return await work(pinnedDatabase);
        } finally {
          transactionActive = false;
        }
      },
      update: vi.fn(async () => true),
      startRun: vi.fn(async () => 'new-server-run'),
      finishRun: vi.fn(async () => {}),
      processRepair: vi.fn(async (_id, _prepared, options) => {
        expect(transactionActive).toBe(false);
        await options.assertCurrentAuthority();
        await options.fencedOpportunityUpdate(
          'opportunity-1',
          f.context.sourceFingerprint,
          { preparedPostingJson: '{}' },
        );
        return { status: 'processed', message: 'Repaired source only.' };
      }),
    };
    return {
      ...f,
      sourceContext: f.context,
      job,
      subject,
      context,
      dependencies,
      attested,
      pinnedDatabase,
      revoke: () => {
        revoked = true;
      },
    };
  }

  it('runs a source-only repair with fresh authority, server bridge and pinned source CAS', async () => {
    const f = await adapterFixture();
    await expect(
      runOpportunityRequirementCoverageRepairJob(
        'opportunity-1',
        f.context,
        f.subject,
        f.dependencies,
      ),
    ).resolves.toMatchObject({ status: 'processed' });
    expect(f.job.save).toHaveBeenCalledOnce();
    expect(f.job.args).toMatchObject({
      sourcePreparationAgentRunId: 'new-server-run',
      repairInputFingerprint: f.attested.prepared.provenance.inputFingerprint,
    });
    expect(f.dependencies.processRepair).toHaveBeenCalledWith(
      'opportunity-1',
      f.attested.prepared,
      expect.objectContaining({ baseReservation: f.attested.baseReservation }),
    );
    expect(f.dependencies.update).toHaveBeenCalledWith(
      'opportunity-1',
      f.sourceContext.sourceFingerprint,
      expect.anything(),
      1,
      f.pinnedDatabase,
    );
  });

  it('rejects a shape-compatible plain job context before any repair work', async () => {
    const f = await adapterFixture();
    await expect(
      runOpportunityRequirementCoverageRepairJob(
        'opportunity-1',
        { ...f.context } as JobExecutionContext,
        f.subject,
        f.dependencies,
      ),
    ).rejects.toThrow('active runner');
    expect(f.dependencies.processRepair).not.toHaveBeenCalled();
  });

  it('rejects a foreign durable owner even with an otherwise valid source receipt', async () => {
    const f = await adapterFixture();
    f.job.args.runtimeWorkspaceSubject = {
      ...f.subject,
      profileId: 'other-profile',
    };
    await expect(
      runOpportunityRequirementCoverageRepairJob(
        'opportunity-1',
        f.context,
        f.subject,
        f.dependencies,
      ),
    ).rejects.toThrow('owner');
    expect(f.dependencies.processRepair).not.toHaveBeenCalled();
  });

  it('observes role revocation while waiting for the source lock', async () => {
    const f = await adapterFixture();
    f.dependencies.withLock = async <T>(
      _id: string,
      work: () => Promise<T>,
    ) => {
      f.revoke();
      return await work();
    };
    await expect(
      runOpportunityRequirementCoverageRepairJob(
        'opportunity-1',
        f.context,
        f.subject,
        f.dependencies,
      ),
    ).rejects.toThrow('revoked');
    expect(f.dependencies.processRepair).not.toHaveBeenCalled();
  });

  it('rejects stale durable repair provenance before starting provider work', async () => {
    const f = await adapterFixture();
    f.job.args.repairInputFingerprint = 'forged-repair-input';
    await expect(
      runOpportunityRequirementCoverageRepairJob(
        'opportunity-1',
        f.context,
        f.subject,
        f.dependencies,
      ),
    ).rejects.toThrow('attestation fingerprint');
    expect(f.dependencies.processRepair).not.toHaveBeenCalled();
    expect(f.dependencies.startRun).not.toHaveBeenCalled();
  });

  it('prevents post-provider publication after revocation and still finalizes AgentRun failure', async () => {
    const f = await adapterFixture();
    f.dependencies.processRepair = async (_id, _prepared, options) => {
      f.revoke();
      await options.fencedOpportunityUpdate(
        'opportunity-1',
        f.sourceContext.sourceFingerprint,
        {},
      );
      return { status: 'processed', message: '' };
    };
    await expect(
      runOpportunityRequirementCoverageRepairJob(
        'opportunity-1',
        f.context,
        f.subject,
        f.dependencies,
      ),
    ).rejects.toThrow('revoked');
    expect(f.dependencies.update).not.toHaveBeenCalled();
    expect(f.dependencies.finishRun).toHaveBeenCalledWith(
      'new-server-run',
      'failed',
      'Operator role revoked.',
      f.subject,
    );
  });

  it('dispatches completed-repair audit-only with exact native re-attestation and zero repair calls', async () => {
    const f = await adapterFixture();
    const cached = await completedFixture();
    const completed = await attestCompletedOpportunityRequirementCoverageRepair(
      cached.opportunity,
      cached.selection,
      cached.db,
    );
    f.job.args.sourceCoverageRepair = {
      contract: SOURCE_COVERAGE_REPAIR_JOB_CONTRACT,
      ...cached.selection,
      stage: 'audit_completed_repair',
      completedRepairLedgerFingerprint:
        completed.completedRepair.ledgerFingerprint,
    };
    f.dependencies.attestCompleted = vi.fn(async () => completed);
    f.dependencies.processAuditReplay = vi.fn(
      async (_id, attestation, options) => {
        expect(attestation.completedRepair.output).toEqual(cached.output);
        expect(options.baseReservation).toEqual({
          calls: 2,
          reservedTokens: 20192,
          spendMicros: 2000,
        });
        const freshReceipt = await options.resolveCompletedRepair();
        expect(freshReceipt.requestId).toBe('completed-repair-request');
        await options.assertCurrentAuthority();
        await options.fencedOpportunityUpdate(
          'opportunity-1',
          f.sourceContext.sourceFingerprint,
          {},
        );
        return {
          status: 'processed',
          message: 'Re-audited completed source repair.',
        };
      },
    );
    await expect(
      runOpportunityRequirementCoverageRepairJob(
        'opportunity-1',
        f.context,
        f.subject,
        f.dependencies,
      ),
    ).resolves.toMatchObject({ status: 'processed' });
    expect(f.dependencies.processAuditReplay).toHaveBeenCalledOnce();
    expect(f.dependencies.processRepair).not.toHaveBeenCalled();
    expect(f.dependencies.attestCompleted).toHaveBeenCalledTimes(2);
  });

  it('rejects a missing completed repair before any processor and never falls back to Luna', async () => {
    const f = await adapterFixture();
    const intent = f.job.args.sourceCoverageRepair as Record<string, unknown>;
    f.job.args.sourceCoverageRepair = {
      ...intent,
      stage: 'audit_completed_repair',
      repairRequestId: 'missing-repair',
    };
    f.dependencies.attestCompleted = vi.fn(async () => {
      throw new Error('Completed native repair receipt is missing.');
    });
    f.dependencies.processAuditReplay = vi.fn(async () => ({
      status: 'processed',
      message: '',
    }));
    await expect(
      runOpportunityRequirementCoverageRepairJob(
        'opportunity-1',
        f.context,
        f.subject,
        f.dependencies,
      ),
    ).rejects.toThrow('receipt is missing');
    expect(f.dependencies.processAuditReplay).not.toHaveBeenCalled();
    expect(f.dependencies.processRepair).not.toHaveBeenCalled();
    expect(f.dependencies.startRun).not.toHaveBeenCalled();
  });

  it('rejects an absent audit-only processor rather than using the repair processor', async () => {
    const f = await adapterFixture();
    const cached = await completedFixture();
    const completed = await attestCompletedOpportunityRequirementCoverageRepair(
      cached.opportunity,
      cached.selection,
      cached.db,
    );
    f.job.args.sourceCoverageRepair = {
      contract: SOURCE_COVERAGE_REPAIR_JOB_CONTRACT,
      ...cached.selection,
      stage: 'audit_completed_repair',
      completedRepairLedgerFingerprint:
        completed.completedRepair.ledgerFingerprint,
    };
    f.dependencies.attestCompleted = vi.fn(async () => completed);
    await expect(
      runOpportunityRequirementCoverageRepairJob(
        'opportunity-1',
        f.context,
        f.subject,
        f.dependencies,
      ),
    ).rejects.toThrow('audit-only processor');
    expect(f.dependencies.processRepair).not.toHaveBeenCalled();
  });
});
