import type { DecisionResult } from '@happyvertical/ai';
import type { PrincipalRun } from '@happyvertical/smrt-agents';
import type { JobExecutionContext } from '@happyvertical/smrt-jobs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  prepareOpportunityScreening,
  resolveOpportunityScreening,
} from './opportunity-screening.js';
import {
  enqueueOpportunityScreeningOnly,
  OPPORTUNITY_SCREENING_ONLY_JOB_CONTRACT,
  OPPORTUNITY_SCREENING_ONLY_QUEUE,
  type OpportunityScreeningOnlyDependencies,
  runOpportunityScreeningOnlyJob,
} from './opportunity-screening-job.js';
import type { CurrentOpportunityAssessmentScreen } from './opportunity-screening-provider.js';
import { fingerprintOpportunitySourceContent } from './opportunity-source-content.js';

const mocks = vi.hoisted(() => ({
  active: undefined as unknown,
  enqueue: vi.fn(),
  prepare: vi.fn(),
  assertOperation: vi.fn(),
}));
vi.mock('@happyvertical/smrt-jobs', () => ({
  SmrtJobCollection: { create: async () => ({ enqueueJob: mocks.enqueue }) },
}));
vi.mock('./db.js', () => ({ getSmrtOptions: () => ({}) }));
vi.mock('./application-workflow.js', () => ({
  withOpportunityLifecycleLock: async <T>(
    _id: string,
    work: () => Promise<T>,
  ) => await work(),
}));
vi.mock('./job-workspace-subject.js', () => ({
  requireActiveRunnerExecutionContext: (context: unknown) => {
    if (context !== mocks.active)
      throw new Error('Not active TaskRunner context.');
    return context;
  },
  runtimeWorkspaceSubjectFromJobArgs: (args: Record<string, unknown>) => {
    if (!args.runtimeWorkspaceSubject)
      throw new Error('Missing workspace subject.');
    return args.runtimeWorkspaceSubject;
  },
  withRuntimeWorkspaceSubject: (args: Record<string, unknown>) => ({
    ...args,
    runtimeWorkspaceSubject: {
      profileId: 'profile-1',
      tenantId: 'tenant-1',
      userId: 'user-1',
    },
  }),
  runAsRevalidatedJobWorkspaceSubject: async <T>(
    current: unknown,
    _capability: unknown,
    work: (current: unknown, run: unknown) => Promise<T>,
  ) => await work(current, { assertOperation: mocks.assertOperation }),
}));
vi.mock('./opportunity-screening-provider.js', () => ({
  prepareCurrentOpportunityAssessmentScreen: mocks.prepare,
  readCurrentOpportunityAssessmentScreen: vi.fn(),
  assertOpportunityAssessmentScreenNotAttempted: vi.fn(),
  evaluateOpportunityAssessmentScreen: vi.fn(),
}));
vi.mock('./opportunity-intelligence-governance.js', () => ({
  startOpportunityIntelligenceAgentRun: vi.fn(),
  finishOpportunityIntelligenceAgentRun: vi.fn(),
}));

const subject = {
  profileId: 'profile-1',
  tenantId: 'tenant-1',
  userId: 'user-1',
};
type NativeJob = NonNullable<
  Awaited<
    ReturnType<NonNullable<OpportunityScreeningOnlyDependencies['getJob']>>
  >
>;
const principal: PrincipalRun = {
  context: {} as PrincipalRun['context'],
  permissions: [],
  allowedTools: [],
  isToolAllowed: () => false,
  assertToolAllowed: () => {
    throw new Error('No tools.');
  },
  assertOperation: mocks.assertOperation,
};
function fixture(mismatch = false) {
  const source = {
    title: 'Software engineer',
    descriptionRaw: 'Build reliable software.',
    locationNotes: 'Canada',
    workMode: 'Remote',
  };
  const profile = {
    preferencesJson: JSON.stringify({
      targetRoles: ['Software engineering'],
      workModes: ['Remote'],
    }),
  };
  let version = 1;
  const prepare = () =>
    prepareOpportunityScreening({
      sourceContentJson: JSON.stringify(source),
      sourceContentFingerprint: fingerprintOpportunitySourceContent(source),
      sourceContentVersion: version,
      profile,
    });
  const prepared = prepare();
  const args: Record<string, unknown> = {
    runtimeWorkspaceSubject: subject,
    screeningOnly: {
      contract: OPPORTUNITY_SCREENING_ONLY_JOB_CONTRACT,
      stage: 'screening_only',
      screeningVersion: prepared.version,
      sourceContentFingerprint:
        prepared.sourceIdentity.sourceContentFingerprint,
      sourceContentVersion: prepared.sourceIdentity.sourceContentVersion,
      sourceFingerprint: prepared.sourceFingerprint,
      profileFingerprint: prepared.profileFingerprint,
      inputFingerprint: prepared.inputFingerprint,
    },
  };
  const context = {
    job: {
      jobId: 'job-1',
      attempt: 1,
      tenantId: subject.tenantId,
      objectType: '@willgriffin/iolaus-site:Opportunity',
      method: 'prepareAssessmentCoverage',
      queue: OPPORTUNITY_SCREENING_ONLY_QUEUE,
    },
  } as unknown as JobExecutionContext;
  mocks.active = context;
  // A separately loaded durable record, never a fabricated Job instance or context.job.save().
  const job: NativeJob = {
    id: 'job-1',
    status: 'running',
    attempts: 1,
    maxAttempts: 1,
    tenantId: subject.tenantId,
    objectId: 'opportunity-1',
    objectType: context.job.objectType,
    method: context.job.method,
    queue: context.job.queue,
    args: structuredClone(args),
  };
  let saved: CurrentOpportunityAssessmentScreen | undefined;
  const transport = vi.fn();
  const freshSpy = vi.fn();
  const runFresh: NonNullable<
    OpportunityScreeningOnlyDependencies['runFresh']
  > = async <T>(
    current: typeof subject,
    capability: Parameters<
      NonNullable<OpportunityScreeningOnlyDependencies['runFresh']>
    >[1],
    work: (current: typeof subject, run: PrincipalRun) => Promise<T>,
  ) => {
    freshSpy(current, capability);
    return await work(current, principal);
  };
  const resolved = (): CurrentOpportunityAssessmentScreen => {
    const current = prepare();
    const witness = current.witnesses.find(
      (w) => w.path === 'sourceContentJson.descriptionRaw',
    )!;
    const output: DecisionResult = {
      model: 'jev-fixture',
      provenance: { provider: 'typesafe', model: 'jev-fixture' },
      usage: { promptTokens: 20, completionTokens: 10, totalTokens: 30 },
      answers: Object.fromEntries(
        Object.entries(current.request.questions).map(([key, q]) => {
          const dimension = key.replace(/__evidence$/u, '');
          const yes =
            dimension === (mismatch ? 'role_mismatch' : 'role_relevant');
          const selected = yes ? witness.id : 'none';
          return [
            key,
            q.type === 'predicate'
              ? { type: 'predicate', probability: yes ? 0.99 : 0.01 }
              : {
                  type: 'choice',
                  choice: selected,
                  confidence: 0.9,
                  probabilities: Object.fromEntries(
                    Object.keys(q.criteria).map((key) => [
                      key,
                      key === selected
                        ? 0.9
                        : 0.1 / (Object.keys(q.criteria).length - 1),
                    ]),
                  ),
                },
          ];
        }),
      ),
    };
    const screen = resolveOpportunityScreening(current, output, 'request-1');
    return {
      outcome: screen.status,
      agentRunId: 'run-1',
      requestId: 'request-1',
      inputFingerprint: 'native-private-fingerprint',
      reservation: {
        calls: 1,
        reservedTokens: current.requestBytes + current.maxOutputTokens,
        spendMicros: 20,
      },
      screen,
    };
  };
  const deps: OpportunityScreeningOnlyDependencies = {
    getJob: vi.fn(async () => job),
    runFresh,
    withLock: async <T>(_id: string, work: () => Promise<T>) => await work(),
    prepare: vi.fn(async () => prepare()),
    read: vi.fn(async () => saved),
    assertNotAttempted: vi.fn(async () => {}),
    startRun: vi.fn(async () => 'run-1'),
    finishRun: vi.fn(async () => {}),
    evaluate: vi.fn(async (_prepared, _opts, providerDeps) => {
      if (!providerDeps?.runFresh)
        throw new Error('Missing native durable provider fence.');
      await providerDeps.runFresh(subject, 'assessment.execute', async () => {
        transport('typesafe');
        saved = resolved();
      });
      return saved!;
    }),
  };
  return {
    args,
    context,
    job,
    deps,
    transport,
    freshSpy,
    source,
    profile,
    prepared,
    prepare,
    resolved,
    set saved(receipt: CurrentOpportunityAssessmentScreen | undefined) {
      saved = receipt;
    },
    changeSource: () => {
      version += 1;
    },
  };
}
beforeEach(() => vi.clearAllMocks());

describe('native screening-only job', () => {
  it.each([
    false,
    true,
  ])('finishes one native PRIVATE screen with cited outcome and no continuation (mismatch=%s)', async (mismatch) => {
    const f = fixture(mismatch);
    const result = await runOpportunityScreeningOnlyJob(
      'opportunity-1',
      f.args,
      f.context,
      subject,
      f.deps,
    );
    expect(result).toMatchObject({
      stage: 'screening_only',
      status: 'screened',
      reused: false,
      receipt: {
        outcome: mismatch ? 'clear_mismatch' : 'uncertain',
        agentRunId: 'run-1',
        requestId: 'request-1',
      },
    });
    expect(result.receipt?.screen.evidence.length).toBeGreaterThan(0);
    if (!mismatch) {
      expect(result.receipt?.screen.plausiblyRelevant).toBe(true);
      expect(result.receipt?.screen.holdReasons).toEqual([]);
      expect(result.receipt?.screen.uncertainties).toContain(
        'sponsorship_unknown',
      );
    }
    expect(f.transport).toHaveBeenCalledExactlyOnceWith('typesafe');
    expect(f.deps.startRun).toHaveBeenCalledExactlyOnceWith({
      opportunityId: 'opportunity-1',
      workspaceSubject: subject,
    });
    expect(f.deps.finishRun).toHaveBeenCalledExactlyOnceWith(
      'run-1',
      'succeeded',
      '',
      subject,
    );
    expect(mocks.enqueue).not.toHaveBeenCalled();
    expect(f.job.args).toEqual(f.args);
    expect(f.deps.getJob).toHaveBeenCalledWith('job-1');
  });
  it.each([
    'runner',
    'durable',
  ] as const)('rejects the ordinary shared intelligence queue at the %s fence without starting a run', async (fence) => {
    const f = fixture();
    expect(f.context.job.queue).toBe('opportunity-screening');
    expect(f.job.queue).toBe(OPPORTUNITY_SCREENING_ONLY_QUEUE);
    if (fence === 'runner') f.context.job.queue = 'opportunity-intelligence';
    else f.job.queue = 'opportunity-intelligence';
    await expect(
      runOpportunityScreeningOnlyJob(
        'opportunity-1',
        f.args,
        f.context,
        subject,
        f.deps,
      ),
    ).rejects.toThrow();
    expect(f.deps.startRun).not.toHaveBeenCalled();
    expect(f.transport).not.toHaveBeenCalled();
    expect(f.deps.evaluate).not.toHaveBeenCalled();
    expect(mocks.enqueue).not.toHaveBeenCalled();
  });
  it('reuses a current native receipt without starting or finishing another run', async () => {
    const f = fixture();
    f.saved = f.resolved();
    const result = await runOpportunityScreeningOnlyJob(
      'opportunity-1',
      f.args,
      f.context,
      subject,
      f.deps,
    );
    expect(result.reused).toBe(true);
    expect(f.transport).not.toHaveBeenCalled();
    expect(f.deps.evaluate).not.toHaveBeenCalled();
    expect(f.deps.startRun).not.toHaveBeenCalled();
    expect(f.deps.finishRun).not.toHaveBeenCalled();
    expect(f.deps.assertNotAttempted).not.toHaveBeenCalled();
    expect(mocks.enqueue).not.toHaveBeenCalled();
  });
  it.each([
    'brand',
    'tenant',
    'attempt',
    'job-id',
    'intent',
    'owner',
    'source',
    'profile',
    'revoked',
    'failed',
    'mixed-stage',
  ] as const)('denies %s before transport or a new native run', async (failure) => {
    const f = fixture();
    if (failure === 'brand') mocks.active = undefined;
    if (failure === 'tenant') f.job.tenantId = 'foreign';
    if (failure === 'attempt') f.job.attempts = 2;
    if (failure === 'job-id') f.job.id = 'foreign';
    if (failure === 'intent')
      (f.args.screeningOnly as Record<string, unknown>).contract = 'foreign';
    if (failure === 'owner')
      f.job.args.runtimeWorkspaceSubject = { ...subject, profileId: 'foreign' };
    if (failure === 'source') f.changeSource();
    if (failure === 'profile')
      f.profile.preferencesJson = JSON.stringify({
        targetRoles: ['Accounting'],
        workModes: ['Remote'],
      });
    if (failure === 'revoked')
      f.freshSpy.mockImplementation(() => {
        throw new Error('Revoked.');
      });
    if (failure === 'failed')
      vi.mocked(f.deps.assertNotAttempted!).mockRejectedValue(
        new Error('Failed exact identity.'),
      );
    if (failure === 'mixed-stage')
      f.args.sourceCoverageStage = { stage: 'extract' };
    await expect(
      runOpportunityScreeningOnlyJob(
        'opportunity-1',
        f.args,
        f.context,
        subject,
        f.deps,
      ),
    ).rejects.toThrow();
    expect(f.transport).not.toHaveBeenCalled();
    expect(f.deps.startRun).not.toHaveBeenCalled();
    expect(mocks.enqueue).not.toHaveBeenCalled();
  });
  it('rechecks durable cancellation inside the provider fresh fence before transport', async () => {
    const f = fixture();
    vi.mocked(f.deps.startRun!).mockImplementation(async () => {
      f.job.status = 'cancelled';
      return 'run-1';
    });
    await expect(
      runOpportunityScreeningOnlyJob(
        'opportunity-1',
        f.args,
        f.context,
        subject,
        f.deps,
      ),
    ).rejects.toThrow('durable job');
    expect(f.transport).not.toHaveBeenCalled();
    expect(f.deps.finishRun).toHaveBeenCalledWith(
      'run-1',
      'failed',
      expect.any(String),
      subject,
    );
  });
  it('denies currentness changed after the actual response without publishing completion', async () => {
    const f = fixture();
    const evaluate = f.deps.evaluate!;
    f.deps.evaluate = vi.fn(
      async (
        ...parameters: Parameters<
          NonNullable<OpportunityScreeningOnlyDependencies['evaluate']>
        >
      ) => {
        const receipt = await evaluate(...parameters);
        f.changeSource();
        return receipt;
      },
    );
    await expect(
      runOpportunityScreeningOnlyJob(
        'opportunity-1',
        f.args,
        f.context,
        subject,
        f.deps,
      ),
    ).rejects.toThrow('durable material');
    expect(f.transport).toHaveBeenCalledOnce();
    expect(f.deps.finishRun).toHaveBeenCalledWith(
      'run-1',
      'failed',
      expect.any(String),
      subject,
    );
    expect(mocks.enqueue).not.toHaveBeenCalled();
  });
  it('holds missing explicit roles before billing and denies malformed profile material without transport', async () => {
    const f = fixture();
    f.profile.preferencesJson = JSON.stringify({
      targetRoles: [],
      workModes: [],
    });
    const prepared = f.prepare();
    for (const envelope of [f.args, f.job.args])
      Object.assign(envelope.screeningOnly as Record<string, unknown>, {
        profileFingerprint: prepared.profileFingerprint,
        inputFingerprint: prepared.inputFingerprint,
      });
    expect(
      await runOpportunityScreeningOnlyJob(
        'opportunity-1',
        f.args,
        f.context,
        subject,
        f.deps,
      ),
    ).toMatchObject({
      status: 'screening_hold',
      holdReasons: ['target_roles_missing'],
    });
    expect(f.transport).not.toHaveBeenCalled();
    expect(f.deps.startRun).not.toHaveBeenCalled();
    f.profile.preferencesJson = '{malformed';
    await expect(
      runOpportunityScreeningOnlyJob(
        'opportunity-1',
        f.args,
        f.context,
        subject,
        f.deps,
      ),
    ).rejects.toThrow();
    expect(f.transport).not.toHaveBeenCalled();
    expect(f.deps.startRun).not.toHaveBeenCalled();
  });
  it('captures only server-derived fingerprint intent on the existing native method with one attempt', async () => {
    const f = fixture();
    mocks.prepare.mockResolvedValue(f.prepared);
    mocks.enqueue.mockResolvedValue({ id: 'enqueued-job' });
    await enqueueOpportunityScreeningOnly('opportunity-1');
    expect(mocks.enqueue).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        objectId: 'opportunity-1',
        objectType: '@willgriffin/iolaus-site:Opportunity',
        method: 'prepareAssessmentCoverage',
        queue: OPPORTUNITY_SCREENING_ONLY_QUEUE,
        tenantId: subject.tenantId,
        maxAttempts: 1,
        args: {
          runtimeWorkspaceSubject: subject,
          screeningOnly: expect.objectContaining({
            contract: OPPORTUNITY_SCREENING_ONLY_JOB_CONTRACT,
            inputFingerprint: f.prepared.inputFingerprint,
            profileFingerprint: f.prepared.profileFingerprint,
          }),
        },
      }),
    );
    const wire = JSON.stringify(mocks.enqueue.mock.calls[0][0].args);
    expect(wire).not.toContain('Software engineering');
    expect(wire).not.toContain('answers');
  });
});
