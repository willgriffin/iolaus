import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { PrincipalRun } from '@happyvertical/smrt-agents';
import type { SmrtJob } from '@happyvertical/smrt-jobs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { RuntimeWorkspaceSubject } from './job-workspace-subject.js';
import type { readRecordedRequirementCoverageOutcome } from './opportunity-requirement-coverage-provider.js';
import { withSqliteOperationLock } from './sqlite-operation-lock.js';

const state = vi.hoisted(() => ({
  subject: { profileId: 'profile-a', tenantId: 'tenant-a', userId: 'user-a' },
}));

type ReadCoverageOutcome = typeof readRecordedRequirementCoverageOutcome;
type RunAsRevalidated = NonNullable<
  import('./opportunity-assessment-dependency-job.js').RunOpportunityAssessmentDependencyJobDependencies['runAsRevalidated']
>;

const mocks = vi.hoisted(() => ({
  coverageOutcome: vi.fn<ReadCoverageOutcome>(async () => ({
    status: 'missing' as const,
  })),
  finishRun: vi.fn(async () => {}),
  jobCollection: { get: vi.fn() },
  prepareSource: vi.fn(),
  recordRun: vi.fn(async () => {}),
  runAsRevalidated: vi.fn(),
  startRun: vi.fn(async () => 'run-1'),
  partialEvidence: vi.fn(async (): Promise<unknown> => undefined),
  assertNotAttempted: vi.fn(async () => {}),
  auditEvidence: vi.fn(async () => ({})),
  preflightEvidence: vi.fn(async () => ({ preparedAudit: {}, admitted: true })),
}));

function testPrincipalRun(
  assertOperation: PrincipalRun['assertOperation'] = async () =>
    undefined as never,
): PrincipalRun {
  return {
    // Test-only partial adapter: these jobs exercise the operation assertion,
    // while the native context itself belongs to executeAsPrincipal tests.
    context: {} as PrincipalRun['context'],
    permissions: [],
    allowedTools: [],
    isToolAllowed: () => false,
    assertToolAllowed: () => {
      throw new Error('No test tools are allowed.');
    },
    assertOperation,
  };
}

function forwardingRunAsRevalidated(
  run: PrincipalRun = testPrincipalRun(),
  spy: (...args: unknown[]) => void = () => {},
): RunAsRevalidated {
  return async <T>(
    requestedSubject: RuntimeWorkspaceSubject,
    capability: 'assessment.execute',
    work: (
      currentSubject: RuntimeWorkspaceSubject,
      currentRun: PrincipalRun,
    ) => Promise<T>,
  ): Promise<T> => {
    spy(requestedSubject, capability);
    return await work(requestedSubject, run);
  };
}

vi.mock('./job-workspace-subject.js', () => ({
  requireActiveRunnerExecutionContext: (context: unknown) => context,
  runAsRevalidatedJobWorkspaceSubject: forwardingRunAsRevalidated(
    testPrincipalRun(),
    mocks.runAsRevalidated,
  ),
  runtimeWorkspaceSubjectFromJobArgs: (args: Record<string, unknown>) =>
    args.runtimeWorkspaceSubject,
  withRuntimeWorkspaceSubject: (args: Record<string, unknown>) => ({
    ...args,
    runtimeWorkspaceSubject: state.subject,
  }),
}));
vi.mock('@happyvertical/smrt-jobs', () => ({
  SmrtJobCollection: { create: vi.fn(async () => mocks.jobCollection) },
}));
vi.mock('@happyvertical/smrt-core', () => ({
  resolveDatabase: vi.fn(async () => ({
    query: vi.fn(async () => ({ rows: [] })),
  })),
}));
vi.mock('./application-workflow.js', () => ({
  runOpportunityLifecycleTransaction: async (
    action: (database: unknown) => Promise<unknown>,
  ) => await action({}),
  withOpportunityLifecycleLock: async (
    _id: string,
    action: () => Promise<unknown>,
  ) => await action(),
}));
vi.mock('./opportunity-details.js', () => ({
  defaultFencedOpportunityUpdate: vi.fn(async () => true),
  processOpportunityWithLlm: mocks.prepareSource,
}));
vi.mock('./opportunity-intelligence-governance.js', () => ({
  finishOpportunityIntelligenceAgentRun: mocks.finishRun,
  startOpportunityIntelligenceAgentRun: mocks.startRun,
}));
vi.mock('./opportunity-assessment-input.js', () => ({
  verifiedOpportunityRequirementCoverage: (opportunity: { ready?: boolean }) =>
    opportunity.ready
      ? { fingerprint: 'coverage', ledger: { id: 'ledger' } }
      : undefined,
}));
vi.mock('./opportunity-requirement-coverage.js', () => ({
  requirementCoverageContextForOpportunity: () => ({
    sourceFingerprint: 'source-a',
  }),
}));
vi.mock('./opportunity-requirement-coverage-provider.js', () => ({
  readPartialOpportunityRequirementEvidence: mocks.partialEvidence,
  evaluateRequirementEvidenceAudit: mocks.auditEvidence,
  requirementCoverageLedgerFingerprint: () => 'ledger-a',
  readRecordedRequirementCoverageOutcome: mocks.coverageOutcome,
  requirementCoverageSourceDependencyFingerprint: () =>
    'source-contract-fingerprint',
}));
vi.mock('./opportunity-requirement-coverage-source-stage-job.js', () => ({
  assertOpportunitySourceExtractionNotAttempted: mocks.assertNotAttempted,
  attestCompletedOpportunitySourceExtraction: vi.fn(),
  preflightCompletedOpportunityRequirementEvidenceAudit:
    mocks.preflightEvidence,
}));
vi.mock('./opportunity-intelligence-job.js', () => ({
  enqueueWorkspaceOpportunityIntelligenceWithStatus: vi.fn(),
}));
vi.mock('./smrt.js', () => ({ getCollection: vi.fn() }));
vi.mock('./db.js', () => ({
  getSmrtOptions: () => ({}),
  getDbConfig: () => ({}),
}));

import {
  enqueueOpportunityAssessmentCoverage,
  OPPORTUNITY_ASSESSMENT_DEPENDENCY_CONTRACT,
  OPPORTUNITY_ASSESSMENT_DEPENDENCY_METHOD,
  OPPORTUNITY_ASSESSMENT_DEPENDENCY_OBJECT_TYPE,
  OPPORTUNITY_ASSESSMENT_DEPENDENCY_QUEUE,
  opportunityAssessmentCoverageDedupeKey,
  opportunityAssessmentSourceDependency,
  runOpportunityAssessmentDependencyJob,
} from './opportunity-assessment-dependency-job';

const source = {
  sourceContentFingerprint: 'source-a',
  sourceContentVersion: 4,
};

function opportunity(overrides: Record<string, unknown> = {}) {
  return { id: 'opp-1', ...source, ...overrides };
}

function queuedJob(overrides: Record<string, unknown> = {}) {
  return {
    args: {},
    id: 'job-1',
    method: OPPORTUNITY_ASSESSMENT_DEPENDENCY_METHOD,
    objectId: 'opp-1',
    objectType: OPPORTUNITY_ASSESSMENT_DEPENDENCY_OBJECT_TYPE,
    queue: OPPORTUNITY_ASSESSMENT_DEPENDENCY_QUEUE,
    status: 'pending',
    tenantId: state.subject.tenantId,
    ...overrides,
  } as unknown as SmrtJob;
}

const noPriorSourceJobBridge = async () => undefined;

function coverageArgs(overrides: Record<string, unknown> = {}) {
  const subject =
    (overrides.runtimeWorkspaceSubject as typeof state.subject | undefined) ??
    state.subject;
  const key = opportunityAssessmentCoverageDedupeKey({
    sourceDependencyFingerprint: 'source-contract-fingerprint',
    subject,
  });
  return {
    assessmentCoverageContract: OPPORTUNITY_ASSESSMENT_DEPENDENCY_CONTRACT,
    assessmentCoverageDedupeKey: key,
    contentFingerprint: source.sourceContentFingerprint,
    contentVersion: source.sourceContentVersion,
    runtimeWorkspaceSubject: subject,
    sourceDependencyFingerprint: 'source-contract-fingerprint',
    ...overrides,
  };
}

describe('opportunity assessment coverage dependency job', () => {
  beforeEach(() => {
    state.subject = {
      profileId: 'profile-a',
      tenantId: 'tenant-a',
      userId: 'user-a',
    };
    mocks.finishRun.mockClear();
    mocks.jobCollection.get.mockReset();
    mocks.coverageOutcome.mockReset();
    mocks.coverageOutcome.mockResolvedValue({ status: 'missing' });
    mocks.prepareSource.mockReset();
    mocks.recordRun.mockReset();
    mocks.recordRun.mockResolvedValue(undefined);
    mocks.startRun.mockClear();
    mocks.partialEvidence.mockReset();
    mocks.partialEvidence.mockResolvedValue(undefined);
    mocks.assertNotAttempted.mockReset();
    mocks.assertNotAttempted.mockResolvedValue(undefined);
    mocks.auditEvidence.mockReset();
    mocks.auditEvidence.mockResolvedValue({});
  });

  it('captures the current subject, derives immutable source identity, and submits through native enqueueJob', async () => {
    const job = queuedJob();
    const collection = {
      enqueueJob: vi.fn(async (data) => Object.assign(job, data)),
      list: vi.fn(async () => []),
    };
    const result = await enqueueOpportunityAssessmentCoverage(
      'opp-1',
      {
        contentFingerprint: 'forged',
        contentVersion: 999,
        reason: 'manual',
        sourcePreparationAgentRunId: 'forged-agent-run',
      },
      {
        collection,
        now: new Date('2026-10-02T00:00:00.000Z'),
        opportunityCollection: { get: vi.fn(async () => opportunity()) },
      },
    );

    expect(result).toMatchObject({
      enqueued: true,
      stage: 'source_preparation',
    });
    expect(result.sourceDependency).toEqual({
      dedupeKey: 'requirement-coverage/v1:opp-1:source-a:4',
      kind: 'requirement_coverage',
      sourceContentFingerprint: 'source-a',
      sourceContentVersion: 4,
    });
    expect(collection.enqueueJob).toHaveBeenCalledWith(
      expect.objectContaining({
        args: expect.objectContaining({
          assessmentCoverageContract:
            OPPORTUNITY_ASSESSMENT_DEPENDENCY_CONTRACT,
          contentFingerprint: 'source-a',
          contentVersion: 4,
          runtimeWorkspaceSubject: state.subject,
        }),
        maxAttempts: 2,
        method: OPPORTUNITY_ASSESSMENT_DEPENDENCY_METHOD,
        tenantId: 'tenant-a',
      }),
    );
    expect(
      (collection.enqueueJob.mock.calls[0]![0].args as Record<string, unknown>)
        .assessmentCoverageDedupeKey,
    ).toMatch(/^assessment-coverage-job\/v1:[a-f0-9]{64}$/);
    expect(
      (collection.enqueueJob.mock.calls[0]![0].args as Record<string, unknown>)
        .sourcePreparationAgentRunId,
    ).toBeUndefined();
  });

  it('dedupes only an exact active owner/source tuple', async () => {
    const args = coverageArgs();
    const exact = queuedJob({ args });
    const foreign = queuedJob({
      args: coverageArgs({
        runtimeWorkspaceSubject: {
          profileId: 'profile-b',
          tenantId: 'tenant-a',
          userId: 'user-a',
        },
      }),
    });
    const collection = {
      enqueueJob: vi.fn(async (data) => queuedJob(data)),
      list: vi.fn(async () => [foreign, exact]),
    };

    const result = await enqueueOpportunityAssessmentCoverage(
      'opp-1',
      {},
      {
        collection,
        opportunityCollection: { get: vi.fn(async () => opportunity()) },
      },
    );

    expect(result).toMatchObject({ enqueued: false, job: exact });
    expect(collection.enqueueJob).not.toHaveBeenCalled();
  });

  it('rejects a durable blocked source outcome without creating a source job', async () => {
    mocks.coverageOutcome.mockResolvedValue({
      reason: 'confidence',
      status: 'blocked',
    });
    const collection = {
      enqueueJob: vi.fn(async (data) => queuedJob(data)),
      list: vi.fn(async () => []),
    };

    await expect(
      enqueueOpportunityAssessmentCoverage(
        'opp-1',
        {},
        {
          collection,
          opportunityCollection: { get: vi.fn(async () => opportunity()) },
        },
      ),
    ).rejects.toMatchObject({ code: 'source_coverage_blocked' });
    expect(collection.enqueueJob).not.toHaveBeenCalled();
  });

  it('reuses an exact terminal source job bridge for a paid failed prerequisite', async () => {
    const exact = queuedJob({
      args: coverageArgs({ sourcePreparationAgentRunId: 'source-run-paid' }),
      status: 'failed',
    });
    const foreign = queuedJob({
      args: coverageArgs({
        runtimeWorkspaceSubject: {
          profileId: 'profile-b',
          tenantId: 'tenant-a',
          userId: 'user-a',
        },
        sourcePreparationAgentRunId: 'foreign-run',
      }),
      status: 'failed',
    });
    mocks.coverageOutcome.mockImplementation(async (_id, _record, bridge) => {
      expect(bridge).toEqual({
        sourceDependencyFingerprint: 'source-contract-fingerprint',
        sourcePreparationAgentRunId: 'source-run-paid',
      });
      return { reason: 'attempt_failed', status: 'blocked' as const };
    });
    const collection = {
      enqueueJob: vi.fn(async (data) => queuedJob(data)),
      list: vi.fn(async () => [foreign, exact]),
    };

    await expect(
      enqueueOpportunityAssessmentCoverage(
        'opp-1',
        {},
        {
          collection,
          opportunityCollection: { get: vi.fn(async () => opportunity()) },
        },
      ),
    ).rejects.toMatchObject({ code: 'source_coverage_blocked' });
    expect(collection.enqueueJob).not.toHaveBeenCalled();
  });

  it('shares a same-tenant terminal source receipt across profiles without exposing its private continuation', async () => {
    const profileA = queuedJob({
      args: coverageArgs({
        sourcePreparationAgentRunId: 'profile-a-source-run',
      }),
      status: 'failed',
    });
    const profileB = {
      profileId: 'profile-b',
      tenantId: 'tenant-a',
      userId: 'user-a',
    };
    state.subject = profileB;
    mocks.coverageOutcome.mockImplementation(async (_id, _record, bridge) => {
      expect(bridge).toEqual({
        sourceDependencyFingerprint: 'source-contract-fingerprint',
        sourcePreparationAgentRunId: 'profile-a-source-run',
      });
      return { reason: 'attempt_failed', status: 'blocked' as const };
    });
    const collection = {
      enqueueJob: vi.fn(async (data) => queuedJob(data)),
      list: vi.fn(async () => [profileA]),
    };

    await expect(
      enqueueOpportunityAssessmentCoverage(
        'opp-1',
        {},
        {
          collection,
          opportunityCollection: { get: vi.fn(async () => opportunity()) },
        },
      ),
    ).rejects.toMatchObject({ code: 'source_coverage_blocked' });
    expect(collection.enqueueJob).not.toHaveBeenCalled();
  });

  it('keeps a zero-cost pre-provider terminal row eligible when the durable outcome remains missing', async () => {
    const terminal = queuedJob({
      args: coverageArgs({ sourcePreparationAgentRunId: 'pre-provider-run' }),
      lastError: 'Workspace subject membership is no longer active.',
      status: 'failed',
    });
    const collection = {
      enqueueJob: vi.fn(async (data) => queuedJob(data)),
      list: vi.fn(async () => [terminal]),
    };

    await expect(
      enqueueOpportunityAssessmentCoverage(
        'opp-1',
        {},
        {
          collection,
          opportunityCollection: { get: vi.fn(async () => opportunity()) },
        },
      ),
    ).resolves.toMatchObject({ enqueued: true });
    expect(mocks.coverageOutcome).toHaveBeenCalledWith(
      'opp-1',
      expect.anything(),
      expect.objectContaining({
        sourcePreparationAgentRunId: 'pre-provider-run',
      }),
    );
  });

  it('surfaces an exact native governed terminal refusal without inferring shared paid-source evidence', async () => {
    const terminal = queuedJob({
      args: coverageArgs({ sourcePreparationAgentRunId: 'server-source-run' }),
      lastError:
        'This idempotency key has a prior terminal failure and requires operator review.',
      status: 'failed',
    });
    const collection = {
      enqueueJob: vi.fn(async (data) => queuedJob(data)),
      list: vi.fn(async () => [terminal]),
    };

    await expect(
      enqueueOpportunityAssessmentCoverage(
        'opp-1',
        {},
        {
          collection,
          opportunityCollection: { get: vi.fn(async () => opportunity()) },
        },
      ),
    ).rejects.toMatchObject({
      code: 'source_coverage_blocked',
      message: expect.stringContaining('operator review'),
    });
    expect(collection.enqueueJob).not.toHaveBeenCalled();
    expect(mocks.coverageOutcome).toHaveReturned();
  });

  it.each([
    [
      'another profile',
      {
        runtimeWorkspaceSubject: {
          profileId: 'profile-b',
          tenantId: 'tenant-a',
          userId: 'user-a',
        },
      },
    ],
    ['changed source', { contentFingerprint: 'older-source' }],
    [
      'changed source contract',
      { sourceDependencyFingerprint: 'older-contract' },
    ],
    ['missing server provenance', { sourcePreparationAgentRunId: undefined }],
  ] satisfies Array<
    [string, Record<string, unknown>]
  >)('does not reuse an operational refusal for %s', async (_name, args) => {
    const terminal = queuedJob({
      args: coverageArgs({
        sourcePreparationAgentRunId: 'server-source-run',
        ...args,
      }),
      lastError:
        'This idempotency key has a prior terminal failure and requires operator review.',
      status: 'failed',
    });
    const collection = {
      enqueueJob: vi.fn(async (data) => queuedJob(data)),
      list: vi.fn(async () => [terminal]),
    };
    await expect(
      enqueueOpportunityAssessmentCoverage(
        'opp-1',
        {},
        {
          collection,
          opportunityCollection: { get: vi.fn(async () => opportunity()) },
        },
      ),
    ).resolves.toMatchObject({ enqueued: true });
  });

  it('prepares source under the lifecycle lock and only then queues a fresh private continuation', async () => {
    let current = opportunity();
    mocks.coverageOutcome.mockImplementation(async (_id, record) =>
      record.ready ? { status: 'ready' } : { status: 'missing' },
    );
    mocks.prepareSource.mockImplementation(async () => {
      current = opportunity({ ready: true });
      return { message: 'prepared', status: 'processed' };
    });
    const enqueueAssessment = vi.fn(async () => {});
    const assertOperation = vi.fn<PrincipalRun['assertOperation']>(
      async () => undefined as never,
    );
    const runAsRevalidated = forwardingRunAsRevalidated(
      testPrincipalRun(assertOperation),
    );

    const result = await runOpportunityAssessmentDependencyJob(
      opportunity(),
      coverageArgs(),
      {} as never,
      state.subject,
      {
        enqueueAssessment,
        getOpportunity: async () => current,
        readCoverageOutcome: mocks.coverageOutcome,
        prepareSource: mocks.prepareSource,
        recordSourcePreparationRun: mocks.recordRun,
        readPriorSourceJobBridge: noPriorSourceJobBridge,
        runAsRevalidated,
        startRun: mocks.startRun,
      },
    );

    expect(result).toEqual({
      message: 'Queued private opportunity assessment.',
      status: 'prepared',
    });
    expect(mocks.prepareSource).toHaveBeenCalledWith(
      'opp-1',
      expect.objectContaining({
        expectedSourceContentFingerprint: 'source-a',
        sourceContentVersion: 4,
      }),
    );
    expect(mocks.finishRun).toHaveBeenCalledWith(
      'run-1',
      'succeeded',
      '',
      state.subject,
    );
    expect(enqueueAssessment).toHaveBeenCalledWith('opp-1');
    expect(assertOperation).toHaveBeenCalledWith('opportunities', 'read');
  });

  it('reuses a durable blocked source outcome without provider work or continuation', async () => {
    mocks.coverageOutcome.mockResolvedValue({
      reason: 'structural',
      status: 'blocked',
    });
    const enqueueAssessment = vi.fn(async () => {});

    const result = await runOpportunityAssessmentDependencyJob(
      opportunity(),
      coverageArgs(),
      {} as never,
      state.subject,
      {
        enqueueAssessment,
        getOpportunity: async () => opportunity(),
        prepareSource: mocks.prepareSource,
        recordSourcePreparationRun: mocks.recordRun,
        readPriorSourceJobBridge: noPriorSourceJobBridge,
        readCoverageOutcome: mocks.coverageOutcome,
      },
    );

    expect(result).toMatchObject({ status: 'skipped' });
    expect(mocks.prepareSource).not.toHaveBeenCalled();
    expect(enqueueAssessment).not.toHaveBeenCalled();
  });

  it("checks a claimed retry row's prior server run before starting another provider attempt", async () => {
    const enqueueAssessment = vi.fn(async () => {});
    const priorBridge = {
      sourceDependencyFingerprint: 'source-contract-fingerprint',
      sourcePreparationAgentRunId: 'paid-prior-attempt',
    };
    mocks.coverageOutcome.mockImplementation(async (_id, _record, bridge) => {
      expect(bridge).toEqual(priorBridge);
      return { reason: 'attempt_failed', status: 'blocked' as const };
    });

    await expect(
      runOpportunityAssessmentDependencyJob(
        opportunity(),
        coverageArgs(),
        {} as never,
        state.subject,
        {
          enqueueAssessment,
          getOpportunity: async () => opportunity(),
          prepareSource: mocks.prepareSource,
          readCoverageOutcome: mocks.coverageOutcome,
          readPriorSourceJobBridge: async () => priorBridge,
          recordSourcePreparationRun: mocks.recordRun,
        },
      ),
    ).resolves.toMatchObject({ status: 'skipped' });
    expect(mocks.startRun).not.toHaveBeenCalled();
    expect(mocks.prepareSource).not.toHaveBeenCalled();
    expect(enqueueAssessment).not.toHaveBeenCalled();
  });

  it('persists the freshly created source AgentRun only on the exact native job row before provider work', async () => {
    const save = vi.fn(async () => {});
    const durableJob = queuedJob({
      args: coverageArgs(),
      attempts: 1,
      save,
      status: 'running',
    });
    mocks.jobCollection.get.mockResolvedValue(durableJob);
    const context = {
      job: {
        attempt: 1,
        jobId: 'job-1',
        method: OPPORTUNITY_ASSESSMENT_DEPENDENCY_METHOD,
        objectId: 'opp-1',
        objectType: OPPORTUNITY_ASSESSMENT_DEPENDENCY_OBJECT_TYPE,
        queue: OPPORTUNITY_ASSESSMENT_DEPENDENCY_QUEUE,
        tenantId: state.subject.tenantId,
      },
    } as never;
    mocks.coverageOutcome.mockResolvedValue({ status: 'missing' });
    mocks.prepareSource.mockResolvedValue({
      message: 'provider failed',
      status: 'error',
    });

    await expect(
      runOpportunityAssessmentDependencyJob(
        opportunity(),
        coverageArgs(),
        context,
        state.subject,
        {
          getOpportunity: async () => opportunity(),
          prepareSource: mocks.prepareSource,
          readCoverageOutcome: mocks.coverageOutcome,
        },
      ),
    ).rejects.toThrow('provider failed');
    expect(save).toHaveBeenCalledOnce();
    expect(
      (durableJob.args as Record<string, unknown>).sourcePreparationAgentRunId,
    ).toBe('run-1');
  });

  it('continues when blank prepared metadata becomes deterministic during source preparation', async () => {
    let current = opportunity({ preparedPostingFingerprint: '', ready: false });
    mocks.coverageOutcome.mockImplementation(async (_id, record) =>
      record.ready ? { status: 'ready' } : { status: 'missing' },
    );
    const enqueueAssessment = vi.fn(async () => {});
    const prepareSource = vi.fn(async (_id, options) => {
      await options.fencedOpportunityUpdate('opp-1', 'source-a', {
        preparedPostingFingerprint: 'deterministic-prepared-posting',
      });
      current = opportunity({
        preparedPostingFingerprint: 'deterministic-prepared-posting',
        ready: true,
      });
      return { message: 'prepared', status: 'processed' as const };
    });

    await expect(
      runOpportunityAssessmentDependencyJob(
        opportunity({ preparedPostingFingerprint: '' }),
        coverageArgs(),
        {} as never,
        state.subject,
        {
          enqueueAssessment,
          getOpportunity: async () => current,
          prepareSource,
          recordSourcePreparationRun: mocks.recordRun,
          readPriorSourceJobBridge: noPriorSourceJobBridge,
          readCoverageOutcome: mocks.coverageOutcome,
        },
      ),
    ).resolves.toMatchObject({ status: 'prepared' });
    expect(enqueueAssessment).toHaveBeenCalledWith('opp-1');
  });

  it('records failure and never continues if the worker crashes after its first fenced preparation update', async () => {
    const enqueueAssessment = vi.fn(async () => {});
    const prepareSource = vi.fn(async (_id, options) => {
      await options.fencedOpportunityUpdate('opp-1', 'source-a', {
        preparedPostingFingerprint: 'deterministic-prepared-posting',
      });
      throw new Error('worker crashed after preparation update');
    });

    await expect(
      runOpportunityAssessmentDependencyJob(
        opportunity({ preparedPostingFingerprint: '' }),
        coverageArgs(),
        {} as never,
        state.subject,
        {
          enqueueAssessment,
          getOpportunity: async () =>
            opportunity({ preparedPostingFingerprint: '' }),
          prepareSource,
          recordSourcePreparationRun: mocks.recordRun,
          readPriorSourceJobBridge: noPriorSourceJobBridge,
          readCoverageOutcome: mocks.coverageOutcome,
        },
      ),
    ).rejects.toThrow('worker crashed after preparation update');
    expect(mocks.finishRun).toHaveBeenCalledWith(
      'run-1',
      'failed',
      'worker crashed after preparation update',
      state.subject,
    );
    expect(enqueueAssessment).not.toHaveBeenCalled();
  });

  it('turns an actual paid source failure into a durable skipped prerequisite through its server run bridge', async () => {
    mocks.coverageOutcome
      .mockResolvedValueOnce({ status: 'missing' })
      .mockImplementationOnce(async (_id, _record, bridge) => {
        expect(bridge).toEqual({
          sourceDependencyFingerprint: 'source-contract-fingerprint',
          sourcePreparationAgentRunId: 'run-1',
        });
        return { reason: 'attempt_failed', status: 'blocked' as const };
      });
    const enqueueAssessment = vi.fn(async () => {});
    const prepareSource = vi.fn(async () => {
      throw new Error('provider request failed after usage');
    });

    await expect(
      runOpportunityAssessmentDependencyJob(
        opportunity(),
        coverageArgs(),
        {} as never,
        state.subject,
        {
          enqueueAssessment,
          getOpportunity: async () => opportunity(),
          prepareSource,
          recordSourcePreparationRun: mocks.recordRun,
          readPriorSourceJobBridge: noPriorSourceJobBridge,
          readCoverageOutcome: mocks.coverageOutcome,
        },
      ),
    ).resolves.toMatchObject({ status: 'skipped' });
    expect(enqueueAssessment).not.toHaveBeenCalled();
  });

  it('serializes two profile requests through the real shared SQLite file lock: one provider call and two continuations', async () => {
    const originalDataDirectory = process.env.SMRT_DATA_DIR;
    const originalAppId = process.env.SMRT_APP_ID;
    const dataDirectory = await mkdtemp(
      join(tmpdir(), 'iolaus-assessment-dependency-lock-'),
    );
    process.env.SMRT_DATA_DIR = dataDirectory;
    process.env.SMRT_APP_ID = 'iolaus-assessment-dependency-lock-fixture';
    try {
      let current = opportunity();
      let releaseProvider!: () => void;
      const providerStarted = new Promise<void>((resolve) => {
        releaseProvider = resolve;
      });
      let providerEntered!: () => void;
      const providerEnteredPromise = new Promise<void>((resolve) => {
        providerEntered = resolve;
      });
      let providerCalls = 0;
      const continuations: string[] = [];
      const readCoverageOutcome = vi.fn<ReadCoverageOutcome>(
        async (_id, record) =>
          record.ready ? { status: 'ready' } : { status: 'missing' },
      );
      const prepareSource = vi.fn(async () => {
        providerCalls += 1;
        providerEntered();
        await providerStarted;
        current = opportunity({ ready: true });
        return { message: 'prepared', status: 'processed' as const };
      });
      const lifecycleLock = async <T>(_id: string, action: () => Promise<T>) =>
        await withSqliteOperationLock('opportunity-lifecycle:opp-1', action);
      const runAsRevalidated = forwardingRunAsRevalidated();
      const run = async (subject: typeof state.subject) =>
        await runOpportunityAssessmentDependencyJob(
          opportunity(),
          coverageArgs({ runtimeWorkspaceSubject: subject }),
          {} as never,
          subject,
          {
            enqueueAssessment: async () => {
              continuations.push(subject.profileId);
            },
            getOpportunity: async () => current,
            prepareSource,
            readCoverageOutcome,
            recordSourcePreparationRun: async () => {},
            readPriorSourceJobBridge: noPriorSourceJobBridge,
            runAsRevalidated,
            withLifecycleLock: lifecycleLock,
          },
        );

      const first = run(state.subject);
      await providerEnteredPromise;
      const profileB = {
        profileId: 'profile-b',
        tenantId: 'tenant-a',
        userId: 'user-a',
      };
      const second = run(profileB);
      releaseProvider();
      await expect(Promise.all([first, second])).resolves.toEqual([
        expect.objectContaining({ status: 'prepared' }),
        expect.objectContaining({ status: 'prepared' }),
      ]);
      expect(providerCalls).toBe(1);
      expect(continuations).toEqual(['profile-a', 'profile-b']);
    } finally {
      if (originalDataDirectory === undefined) delete process.env.SMRT_DATA_DIR;
      else process.env.SMRT_DATA_DIR = originalDataDirectory;
      if (originalAppId === undefined) delete process.env.SMRT_APP_ID;
      else process.env.SMRT_APP_ID = originalAppId;
      await rm(dataDirectory, { force: true, recursive: true });
    }
  });

  it('does not continue after a provider failure or stale source', async () => {
    const enqueueAssessment = vi.fn(async () => {});
    mocks.coverageOutcome.mockResolvedValue({ status: 'missing' });
    mocks.prepareSource.mockResolvedValue({
      message: 'provider failed',
      status: 'error',
    });

    await expect(
      runOpportunityAssessmentDependencyJob(
        opportunity(),
        coverageArgs(),
        {} as never,
        state.subject,
        {
          enqueueAssessment,
          getOpportunity: async () => opportunity(),
          readCoverageOutcome: mocks.coverageOutcome,
          prepareSource: mocks.prepareSource,
          recordSourcePreparationRun: mocks.recordRun,
          readPriorSourceJobBridge: noPriorSourceJobBridge,
        },
      ),
    ).rejects.toThrow('provider failed');
    expect(enqueueAssessment).not.toHaveBeenCalled();

    const stale = opportunity({ sourceContentFingerprint: 'source-b' });
    const result = await runOpportunityAssessmentDependencyJob(
      stale,
      coverageArgs(),
      {} as never,
      state.subject,
      { enqueueAssessment, getOpportunity: async () => stale },
    );
    expect(result).toMatchObject({ status: 'skipped' });
    expect(enqueueAssessment).not.toHaveBeenCalled();
  });

  it('stops before source work when authority is revoked while waiting for the lifecycle lock', async () => {
    const getOpportunity = vi.fn(async () => opportunity());
    const enqueueAssessment = vi.fn(async () => {});
    const revoked = vi.fn(async () => {
      throw new Error('workspace membership is no longer active');
    });

    await expect(
      runOpportunityAssessmentDependencyJob(
        opportunity(),
        coverageArgs(),
        {} as never,
        state.subject,
        {
          enqueueAssessment,
          getOpportunity,
          prepareSource: mocks.prepareSource,
          recordSourcePreparationRun: mocks.recordRun,
          readPriorSourceJobBridge: noPriorSourceJobBridge,
          runAsRevalidated: revoked,
          withLifecycleLock: async (_id, action) => await action(),
        },
      ),
    ).rejects.toThrow('workspace membership is no longer active');
    expect(getOpportunity).not.toHaveBeenCalled();
    expect(mocks.prepareSource).not.toHaveBeenCalled();
    expect(enqueueAssessment).not.toHaveBeenCalled();
  });

  it('keeps provider accounting but fences source persistence and continuation after a post-provider revocation', async () => {
    let providerSettled = false;
    const enqueueAssessment = vi.fn(async () => {});
    const runAsSpy = vi.fn();
    const runAsRevalidated: RunAsRevalidated = async <T>(
      requestedSubject: RuntimeWorkspaceSubject,
      capability: 'assessment.execute',
      work: (
        currentSubject: RuntimeWorkspaceSubject,
        currentRun: PrincipalRun,
      ) => Promise<T>,
    ): Promise<T> => {
      runAsSpy(requestedSubject, capability);
      if (providerSettled) {
        throw new Error('assessment capability revoked');
      }
      return await work(requestedSubject, testPrincipalRun());
    };
    const providerFinished = vi.fn(() => {
      providerSettled = true;
    });
    const prepareSource = vi.fn(async (_id, options) => {
      providerFinished();
      await options.fencedOpportunityUpdate('opp-1', 'source-a', {
        preparedPostingJson: '{}',
      });
      return { message: 'prepared', status: 'processed' as const };
    });

    await expect(
      runOpportunityAssessmentDependencyJob(
        opportunity(),
        coverageArgs(),
        {} as never,
        state.subject,
        {
          enqueueAssessment,
          getOpportunity: async () => opportunity(),
          prepareSource,
          recordSourcePreparationRun: mocks.recordRun,
          readPriorSourceJobBridge: noPriorSourceJobBridge,
          runAsRevalidated,
        },
      ),
    ).rejects.toThrow('assessment capability revoked');
    expect(providerFinished).toHaveBeenCalledOnce();
    expect(mocks.finishRun).toHaveBeenCalledWith(
      'run-1',
      'failed',
      'assessment capability revoked',
      state.subject,
    );
    expect(enqueueAssessment).not.toHaveBeenCalled();
  });

  it('exposes the source prerequisite identity without the owner tuple', () => {
    expect(
      opportunityAssessmentSourceDependency({
        opportunityId: 'opp-1',
        sourceContentFingerprint: 'source-a',
        sourceContentVersion: 4,
        subject: state.subject,
      }),
    ).toEqual({
      dedupeKey: 'requirement-coverage/v1:opp-1:source-a:4',
      kind: 'requirement_coverage',
      sourceContentFingerprint: 'source-a',
      sourceContentVersion: 4,
    });
  });

  it('resumes actual source evidence on its original run without another extraction or a new run', async () => {
    const actual = {
      requestId: 'actual-extraction',
      agentRunId: 'original-source-run',
      workspaceSubject: state.subject,
      context: {
        sourceFingerprint: 'source-a',
        sourceVersion: 4,
        extractionFingerprint: 'exact-current',
      },
      ledgerFingerprint: 'ledger-a',
      ledger: {},
      posting: { fingerprint: 'prepared', version: 'v1' },
      reservation: { calls: 2, reservedTokens: 30000, spendMicros: 3000 },
    } as never;
    let recorded = false;
    const partial = {
      acceptedRequirements: [{ id: 'verified-row' }],
      fingerprint: 'partial-source',
    };
    const readCompleted = vi.fn(async () => actual);
    const readPartialEvidence = vi.fn(async () =>
      recorded ? (partial as never) : undefined,
    );
    const auditEvidence = vi.fn(async () => {
      recorded = true;
      return {} as never;
    });
    const preflightEvidence = vi.fn(async () => ({
      preparedAudit: {} as never,
      admitted: true,
    }));
    const enqueueAssessment = vi.fn(async () => {});
    const result = await runOpportunityAssessmentDependencyJob(
      opportunity({ preparedPostingJson: '{"requirementCoverage":{}}' }),
      coverageArgs(),
      {} as never,
      state.subject,
      {
        getOpportunity: async () =>
          opportunity({ preparedPostingJson: '{"requirementCoverage":{}}' }),
        readPriorSourceJobBridge: noPriorSourceJobBridge,
        readCompletedExtraction: readCompleted,
        readPartialEvidence,
        preflightEvidence,
        auditEvidence,
        enqueueAssessment,
        recordSourcePreparationRun: mocks.recordRun,
      },
    );
    expect(result).toMatchObject({
      status: 'prepared',
      sourceStatus: 'partial',
    });
    expect(mocks.startRun).not.toHaveBeenCalled();
    expect(mocks.prepareSource).not.toHaveBeenCalled();
    expect(readCompleted).toHaveBeenCalledTimes(2);
    expect(preflightEvidence).toHaveBeenCalledWith(actual);
    expect(auditEvidence).toHaveBeenCalledWith(
      {},
      expect.objectContaining({
        agentRunId: 'original-source-run',
        historicalReservation: {
          calls: 2,
          reservedTokens: 30000,
          spendMicros: 3000,
        },
      }),
    );
    expect(enqueueAssessment).toHaveBeenCalledOnce();
  });

  it('retains a completed checkpoint when its exact evidence audit cannot fit and never mutates a foreign run', async () => {
    const actual = {
      requestId: 'actual-extraction',
      agentRunId: 'original-source-run',
      workspaceSubject: state.subject,
      context: {
        sourceFingerprint: 'source-a',
        sourceVersion: 4,
        extractionFingerprint: 'exact-current',
      },
      ledgerFingerprint: 'ledger-a',
      reservation: { calls: 4, reservedTokens: 80000, spendMicros: 100000 },
    };
    const preflightEvidence = vi.fn(async () => ({
      preparedAudit: {} as never,
      admitted: false,
    }));
    const auditEvidence = vi.fn();
    const enqueueAssessment = vi.fn();
    const deps = {
      getOpportunity: async () => opportunity(),
      readPriorSourceJobBridge: noPriorSourceJobBridge,
      readCompletedExtraction: vi.fn(async () => actual as never),
      preflightEvidence,
      auditEvidence,
      enqueueAssessment,
      recordSourcePreparationRun: mocks.recordRun,
    };
    await expect(
      runOpportunityAssessmentDependencyJob(
        opportunity(),
        coverageArgs(),
        {} as never,
        state.subject,
        deps,
      ),
    ).resolves.toMatchObject({
      status: 'skipped',
      sourceStatus: 'audit_blocked',
    });
    expect(auditEvidence).not.toHaveBeenCalled();
    expect(mocks.startRun).not.toHaveBeenCalled();
    expect(mocks.prepareSource).not.toHaveBeenCalled();
    expect(mocks.finishRun).not.toHaveBeenCalled();
    await expect(
      runOpportunityAssessmentDependencyJob(
        opportunity(),
        coverageArgs(),
        {} as never,
        state.subject,
        {
          ...deps,
          readCompletedExtraction: async () =>
            ({
              ...actual,
              workspaceSubject: {
                ...state.subject,
                profileId: 'other-profile',
              },
            }) as never,
        },
      ),
    ).resolves.toMatchObject({
      status: 'skipped',
      sourceStatus: 'operator_required',
    });
    expect(enqueueAssessment).not.toHaveBeenCalled();
  });

  it('prepares one extraction checkpoint, reattests it, and uses only the canonical evidence audit before private continuation', async () => {
    const actual = {
      requestId: 'actual-extraction',
      agentRunId: 'run-1',
      workspaceSubject: state.subject,
      context: {
        sourceFingerprint: 'source-a',
        sourceVersion: 4,
        extractionFingerprint: 'exact-current',
      },
      ledgerFingerprint: 'ledger-a',
      ledger: {},
      posting: { fingerprint: 'prepared', version: 'v1' },
      reservation: { calls: 1, reservedTokens: 10096, spendMicros: 2648 },
    } as never;
    let extracted = false,
      audited = false;
    const prepareSource = vi.fn<
      NonNullable<
        import('./opportunity-assessment-dependency-job.js').RunOpportunityAssessmentDependencyJobDependencies['prepareSource']
      >
    >(async (_id, options) => {
      expect(options.sourceExtractionStage).toBe('extract-only');
      await options.assertCurrentAuthority();
      extracted = true;
      return { status: 'processed' as const, message: 'checkpoint saved' };
    });
    const readCompleted = vi.fn(async () => (extracted ? actual : undefined));
    const auditEvidence = vi.fn(async () => {
      audited = true;
      return {} as never;
    });
    const enqueueAssessment = vi.fn();
    await expect(
      runOpportunityAssessmentDependencyJob(
        opportunity(),
        coverageArgs(),
        {} as never,
        state.subject,
        {
          getOpportunity: async () =>
            opportunity({ preparedPostingJson: '{"requirementCoverage":{}}' }),
          readPriorSourceJobBridge: noPriorSourceJobBridge,
          recordSourcePreparationRun: mocks.recordRun,
          readCompletedExtraction: readCompleted,
          prepareSource,
          auditEvidence,
          preflightEvidence: async () => ({
            preparedAudit: {} as never,
            admitted: true,
          }),
          readPartialEvidence: async () =>
            audited
              ? ({
                  acceptedRequirements: [{ id: 'source-row' }],
                  fingerprint: 'partial',
                } as never)
              : undefined,
          enqueueAssessment,
        },
      ),
    ).resolves.toMatchObject({ status: 'prepared', sourceStatus: 'partial' });
    expect(mocks.startRun).toHaveBeenCalledOnce();
    expect(prepareSource).toHaveBeenCalledOnce();
    expect(auditEvidence).toHaveBeenCalledOnce();
    expect(enqueueAssessment).toHaveBeenCalledOnce();
  });
});
