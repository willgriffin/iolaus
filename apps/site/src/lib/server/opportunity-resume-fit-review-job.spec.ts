import { createHash } from 'node:crypto';
import type { PrincipalRun } from '@happyvertical/smrt-agents';
import type { JobExecutionContext } from '@happyvertical/smrt-jobs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  OPPORTUNITY_RESUME_FIT_REVIEW_JOB_CONTRACT,
  OPPORTUNITY_RESUME_FIT_REVIEW_PILOT_QUEUE,
  type OpportunityResumeFitReviewJobDependencies,
  enqueueOpportunityResumeFitReviewPilot,
  runOpportunityResumeFitReviewJob,
} from './opportunity-resume-fit-review-job.js';
import {
  OPPORTUNITY_RESUME_FIT_REVIEW_VERSION,
  OPPORTUNITY_RESUME_FIT_REVIEW_QUOTE_VERSION,
  type PreparedOpportunityResumeFitReview,
  type OpportunityResumeFitReviewResult,
} from './opportunity-resume-fit-review.js';
import { OPPORTUNITY_SCREENING_VERSION } from './opportunity-screening.js';
import type { CurrentOpportunityAssessmentScreen } from './opportunity-screening-provider.js';
import type { OpportunityReviewOverlay } from './opportunity-review-overlay.js';

const mocks = vi.hoisted(() => ({
  active: undefined as unknown,
  enqueue: vi.fn(),
  get: vi.fn(),
  prepare: vi.fn(),
  read: vi.fn(),
  preflight: vi.fn(),
  assertNotAttempted: vi.fn(),
  readScreen: vi.fn(),
  reviews: vi.fn(),
  assertOperation: vi.fn(),
}));
vi.mock('@happyvertical/smrt-jobs', () => ({
  SmrtJobCollection: { create: async () => ({ enqueueJob: mocks.enqueue }) },
}));
vi.mock('./smrt.js', () => ({
  getCollection: async (name: string) => ({
    get: (where: unknown, options: unknown) => mocks.get(name, where, options),
  }),
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
    if (context !== mocks.active) throw new Error('Not active native runner.');
    return context;
  },
  runtimeWorkspaceSubjectFromJobArgs: (args: Record<string, unknown>) =>
    args.runtimeWorkspaceSubject,
  withRuntimeWorkspaceSubject: (args: Record<string, unknown>) => ({
    ...args,
    runtimeWorkspaceSubject: {
      tenantId: 'tenant',
      userId: 'user',
      profileId: 'profile',
    },
  }),
  runAsRevalidatedJobWorkspaceSubject: async <T>(
    current: unknown,
    _capability: unknown,
    work: (current: unknown, run: unknown) => Promise<T>,
  ) => await work(current, { assertOperation: mocks.assertOperation }),
}));
vi.mock('./opportunity-intelligence-governance.js', () => ({
  startOpportunityIntelligenceAgentRun: vi.fn(),
  finishOpportunityIntelligenceAgentRun: vi.fn(),
}));
vi.mock('./opportunity-review-overlay.js', () => ({
  loadCurrentOpportunityReviewOverlays: mocks.reviews,
}));
vi.mock('./opportunity-screening-provider.js', () => ({
  readCurrentOpportunityAssessmentScreen: mocks.readScreen,
}));
vi.mock('./opportunity-resume-fit-review.js', () => ({
  OPPORTUNITY_RESUME_FIT_REVIEW_VERSION:
    'opportunity-resume-fit-review/v2-catalog-aliases',
  OPPORTUNITY_RESUME_FIT_REVIEW_QUOTE_VERSION:
    'opportunity-resume-fit-review/v3-exact-quotes',
  prepareCurrentOpportunityResumeFitReview: mocks.prepare,
  preflightOpportunityResumeFitReview: mocks.preflight,
  readCurrentOpportunityResumeFitReview: mocks.read,
  readCurrentOpportunityResumeFitReviewReceipt: mocks.read,
  assertOpportunityResumeFitReviewNotAttempted: mocks.assertNotAttempted,
  evaluateOpportunityResumeFitReview: vi.fn(),
  storeOpportunityResumeFitReview: vi.fn(),
}));
const subject = { tenantId: 'tenant', userId: 'user', profileId: 'profile' };
const hash = (value: unknown) =>
  createHash('sha256').update(JSON.stringify(value)).digest('hex');
type NativeJob = NonNullable<
  Awaited<
    ReturnType<NonNullable<OpportunityResumeFitReviewJobDependencies['getJob']>>
  >
>;
function fixture(
  model: PreparedOpportunityResumeFitReview['model'] = 'openai/gpt-6.1-sol',
) {
  const opportunity = {
    id: 'opportunity',
    sourceContentFingerprint: 'source-fp',
    sourceContentVersion: 1,
  };
  const profile = {
    id: 'profile',
    tenantId: 'tenant',
    ownerUserId: 'user',
    active: true,
    name: 'Candidate',
  };
  const prepared: PreparedOpportunityResumeFitReview = {
    version:
      model === 'openai/gpt-6-luna'
        ? OPPORTUNITY_RESUME_FIT_REVIEW_QUOTE_VERSION
        : OPPORTUNITY_RESUME_FIT_REVIEW_VERSION,
    model,
    opportunityId: 'opportunity',
    fingerprint:
      model === 'openai/gpt-6.1-sol'
        ? 'prepared'
        : hash({ material: 'prepared', model }),
    candidateMaterialFingerprint: 'complete-catalog',
    evidenceFingerprint: 'actual-global-evidence',
    sourceContentFingerprint: 'source-fp',
    sourceContentVersion: 1,
    messages: [{ role: 'user', content: 'Full catalog fixture' }],
    candidates: [],
    clauses: [],
    requirements: [
      {
        key: 'r0',
        id: 'actual-criterion',
        text: 'Build software',
        clauseKeys: ['p0'],
      },
    ],
    unresolvedClauseIds: ['unresolved'],
    sourceComplete: false,
    outputShapeBytes: 100,
    maximumSerializedOutput: JSON.stringify({
      requirements: [
        {
          id: 'r0',
          status: 'uncertain',
          seniority: 'not_applicable',
          note: '',
          candidate: [],
          posting: [{ id: 'p0', start: 0, end: 1 }],
        },
      ],
    }),
    visibleOutputTokens: model === 'openai/gpt-6-luna' ? 4096 : 3500,
    reasoningTokens: 1024,
  };
  const screen: CurrentOpportunityAssessmentScreen = {
    requestId: 'actual-screen',
    agentRunId: 'screen-run',
    inputFingerprint: 'opaque-screen',
    outcome: 'potentially_relevant',
    reservation: { calls: 1, reservedTokens: 1000, spendMicros: 100 },
    screen: {
      version: OPPORTUNITY_SCREENING_VERSION,
      status: 'potentially_relevant',
      requestId: 'actual-screen',
      inputFingerprint: 'screen-material',
      sourceFingerprint: 'captured-source',
      profileFingerprint: 'screen-profile',
      sourceIdentity: {
        sourceContentFingerprint: 'source-fp',
        sourceContentVersion: 1,
      },
      evidence: [],
      uncertainties: [],
      mismatches: [],
      plausiblyRelevant: true,
      holdReasons: [],
      conditionalPaths: [],
      probabilities: {
        role_relevant: 0.99,
        role_mismatch: 0,
        country_mismatch: 0,
        work_mode_mismatch: 0,
        authorization_mismatch: 0,
        unresolved_constraint: 0,
        sponsorship_path: 0,
      },
      model: 'jev',
      provenance: { provider: 'typesafe', model: 'jev' },
    },
  };
  const review: OpportunityResumeFitReviewResult = {
    contractVersion: prepared.version,
    mode: 'advisory',
    agentRunId: 'sol-run',
    requestId: 'actual-sol',
    inputFingerprint: 'opaque-sol',
    fingerprint: prepared.fingerprint,
    candidateMaterialFingerprint: prepared.candidateMaterialFingerprint,
    evidenceFingerprint: prepared.evidenceFingerprint,
    sourceContentFingerprint: prepared.sourceContentFingerprint,
    sourceContentVersion: 1,
    model,
    provider: 'bifrost',
    coverage: {
      candidateSourceCount: 1,
      reviewedRequirementIds: ['actual-criterion'],
      unresolvedClauseIds: ['unresolved'],
      sourceComplete: false,
      fullFit: 'unknown',
    },
    requirements: [],
  };
  const intent = {
    contract: OPPORTUNITY_RESUME_FIT_REVIEW_JOB_CONTRACT,
    reviewVersion: prepared.version,
    reviewModel: prepared.model,
    fingerprint: prepared.fingerprint,
    candidateMaterialFingerprint: prepared.candidateMaterialFingerprint,
    evidenceFingerprint: prepared.evidenceFingerprint,
    sourceContentFingerprint: prepared.sourceContentFingerprint,
    sourceContentVersion: 1,
    profileRecordFingerprint: hash(profile),
    screeningRequestId: screen.requestId,
    screeningInputFingerprint: screen.inputFingerprint,
  };
  const args: Record<string, unknown> = {
    runtimeWorkspaceSubject: subject,
    resumeFitReview: intent,
  };
  const context = {
    job: {
      jobId: 'job',
      attempt: 1,
      tenantId: 'tenant',
      objectType: '@willgriffin/iolaus-site:Opportunity',
      method: 'prepareAssessmentCoverage',
      queue: OPPORTUNITY_RESUME_FIT_REVIEW_PILOT_QUEUE,
    },
  } as unknown as JobExecutionContext;
  mocks.active = context;
  const job: NativeJob = {
    id: 'job',
    status: 'running',
    attempts: 1,
    maxAttempts: 1,
    tenantId: 'tenant',
    objectId: 'opportunity',
    objectType: context.job.objectType,
    method: context.job.method,
    queue: context.job.queue,
    args: structuredClone(args),
  };
  const principal: PrincipalRun = {
    context: {} as PrincipalRun['context'],
    permissions: [],
    allowedTools: [],
    isToolAllowed: () => false,
    assertToolAllowed: () => {
      throw new Error('No tools');
    },
    assertOperation: mocks.assertOperation,
  };
  const runFresh: NonNullable<
    OpportunityResumeFitReviewJobDependencies['runFresh']
  > = async <T>(
    current: typeof subject,
    _capability: Parameters<
      NonNullable<OpportunityResumeFitReviewJobDependencies['runFresh']>
    >[1],
    work: (current: typeof subject, run: PrincipalRun) => Promise<T>,
  ): Promise<T> => await work(current, principal);
  let actual: OpportunityResumeFitReviewResult | undefined;
  let published = false;
  const transport = vi.fn();
  const evaluate: NonNullable<
    OpportunityResumeFitReviewJobDependencies['evaluate']
  > = vi.fn(async (_prepared, options) => {
    await options.revalidateMaterial();
    transport();
    actual = review;
    await options.revalidateMaterial();
    return review;
  });
  const deps: OpportunityResumeFitReviewJobDependencies = {
    getJob: vi.fn(async () => job),
    getOpportunity: vi.fn(async () => opportunity),
    getProfile: vi.fn(async () => profile),
    runFresh,
    withLock: async <T>(_id: string, work: () => Promise<T>) => await work(),
    prepare: vi.fn(async () => prepared),
    preflight: vi.fn(async () => ({
      requestBytes: 1000,
      inputTokenCount: 200,
      inputTokenCeiling: 1000,
      maxOutputTokens: prepared.visibleOutputTokens + 1024,
      visibleOutputTokens: prepared.visibleOutputTokens,
      reasoningTokens: 1024 as const,
      outputShapeTokens: 40,
      reservedTokens: 1000 + prepared.visibleOutputTokens + 1024,
      reservedSpendMicros: model === 'openai/gpt-6-luna' ? 2660 : 47240,
      calls: 1,
      fits: true,
    })),
    read: vi.fn(async () => (published ? actual : undefined)),
    readReceipt: vi.fn(async () => actual),
    readScreen: vi.fn(async () => screen),
    readReviews: vi.fn(async () => new Map<string, OpportunityReviewOverlay>()),
    assertNotAttempted: vi.fn(async () => {}),
    evaluate,
    store: vi.fn(async () => {
      published = true;
      return true;
    }),
    startRun: vi.fn(async () => 'sol-run'),
    finishRun: vi.fn(async () => {}),
  };
  return {
    opportunity,
    profile,
    prepared,
    review,
    screen,
    job,
    args,
    context,
    deps,
    transport,
    reuse: () => {
      actual = review;
      published = true;
    },
  };
}
beforeEach(() => {
  vi.clearAllMocks();
});
describe('native dedicated resume review', () => {
  it('runs one Sol review and stores only its actual PRIVATE receipt on one native run', async () => {
    const f = fixture();
    await expect(
      runOpportunityResumeFitReviewJob(
        'opportunity',
        f.args,
        f.context,
        subject,
        f.deps,
      ),
    ).resolves.toMatchObject({
      status: 'reviewed',
      reused: false,
      review: { mode: 'advisory', coverage: { fullFit: 'unknown' } },
    });
    expect(f.transport).toHaveBeenCalledOnce();
    expect(f.deps.readReceipt).toHaveBeenCalled();
    expect(f.deps.read).toHaveBeenCalledTimes(2);
    expect(f.deps.startRun).toHaveBeenCalledOnce();
    expect(f.deps.store).toHaveBeenCalledWith(
      expect.objectContaining({
        agentRunId: 'sol-run',
        result: f.review,
        subject,
      }),
    );
    expect(f.deps.finishRun).toHaveBeenCalledWith(
      'sol-run',
      'succeeded',
      '',
      subject,
    );
  });
  it('reuses the actual current receipt with zero new run, provider or write', async () => {
    const f = fixture();
    f.reuse();
    await expect(
      runOpportunityResumeFitReviewJob(
        'opportunity',
        f.args,
        f.context,
        subject,
        f.deps,
      ),
    ).resolves.toMatchObject({ reused: true });
    expect(f.transport).not.toHaveBeenCalled();
    expect(f.deps.startRun).not.toHaveBeenCalled();
    expect(f.deps.store).not.toHaveBeenCalled();
  });
  it('executes the newly captured Luna review without reusing or changing the historical Sol receipt', async () => {
    const old = fixture();
    old.reuse();
    const savedSol = structuredClone(old.review);
    const f = fixture('openai/gpt-6-luna');
    const currentRead = f.deps.read!;
    f.deps.read = vi.fn(
      async (
        ...args: Parameters<
          NonNullable<OpportunityResumeFitReviewJobDependencies['read']>
        >
      ) =>
        old.review.fingerprint === f.prepared.fingerprint &&
        old.review.model === f.prepared.model
          ? old.review
          : await currentRead(...args),
    );
    expect(f.prepared.fingerprint).not.toBe(old.prepared.fingerprint);
    expect(f.args.resumeFitReview).toMatchObject({
      reviewModel: 'openai/gpt-6-luna',
      reviewVersion: OPPORTUNITY_RESUME_FIT_REVIEW_QUOTE_VERSION,
      fingerprint: f.prepared.fingerprint,
    });
    await expect(
      runOpportunityResumeFitReviewJob(
        'opportunity',
        f.args,
        f.context,
        subject,
        f.deps,
      ),
    ).resolves.toMatchObject({
      reused: false,
      review: { model: 'openai/gpt-6-luna' },
    });
    expect(f.transport).toHaveBeenCalledOnce();
    expect(f.deps.evaluate).toHaveBeenCalledWith(
      expect.objectContaining({ model: 'openai/gpt-6-luna' }),
      expect.any(Object),
    );
    expect(f.deps.store).toHaveBeenCalledOnce();
    expect(old.review).toEqual(savedSol);
  });
  it.each([
    'cached',
    'completed',
    'published',
  ])('refuses a Sol %s result for a model-pinned Luna intent', async (stage) => {
    const f = fixture('openai/gpt-6-luna');
    if (stage === 'cached') f.reuse();
    if (stage !== 'published') f.review.model = 'openai/gpt-6.1-sol';
    else {
      const currentRead = f.deps.read!;
      f.deps.read = vi.fn(
        async (
          ...args: Parameters<
            NonNullable<OpportunityResumeFitReviewJobDependencies['read']>
          >
        ) => {
          const current = await currentRead(...args);
          return current
            ? { ...current, model: 'openai/gpt-6.1-sol' as const }
            : undefined;
        },
      );
    }
    await expect(
      runOpportunityResumeFitReviewJob(
        'opportunity',
        f.args,
        f.context,
        subject,
        f.deps,
      ),
    ).rejects.toThrow('PRIVATE');
    if (stage === 'cached') expect(f.transport).not.toHaveBeenCalled();
    if (stage !== 'published') expect(f.deps.store).not.toHaveBeenCalled();
  });
  it.each([
    'queue',
    'owner',
    'attempt',
    'profile',
    'source',
    'catalog',
    'intent',
    'model',
    'screen',
    'human',
    'mixed',
  ])('denies %s before creating a run or invoking Sol', async (cause) => {
    const f = fixture();
    if (cause === 'queue') f.context.job.queue = 'opportunity-intelligence';
    if (cause === 'owner') f.job.tenantId = 'foreign';
    if (cause === 'attempt') f.job.attempts = 2;
    if (cause === 'profile') f.profile.active = false;
    if (cause === 'source') f.opportunity.sourceContentVersion = 2;
    if (cause === 'catalog')
      f.prepared.candidateMaterialFingerprint = 'changed';
    if (cause === 'intent')
      (f.args.resumeFitReview as Record<string, unknown>).fingerprint =
        'forged';
    if (cause === 'model') f.prepared.model = 'openai/gpt-6-luna';
    if (cause === 'screen') f.screen.outcome = 'clear_mismatch';
    if (cause === 'human')
      f.deps.readReviews = vi.fn(
        async () =>
          new Map<string, OpportunityReviewOverlay>([
            [
              'opportunity',
              {
                humanRating: null,
                humanReviewNotes: '',
                humanReviewStatus: 'reject',
                reviewedAt: null,
                reviewedByProfileId: 'profile',
                reviewedByUserId: 'user',
              },
            ],
          ]),
      );
    if (cause === 'mixed') f.args.sourceCoverageStage = { stage: 'extract' };
    await expect(
      runOpportunityResumeFitReviewJob(
        'opportunity',
        f.args,
        f.context,
        subject,
        f.deps,
      ),
    ).rejects.toThrow();
    expect(f.transport).not.toHaveBeenCalled();
    expect(f.deps.startRun).not.toHaveBeenCalled();
    expect(f.deps.store).not.toHaveBeenCalled();
  });
  it('refuses failed/running identity before starting another run', async () => {
    const f = fixture();
    f.deps.assertNotAttempted = vi.fn(async () => {
      throw new Error('Prior terminal failure');
    });
    await expect(
      runOpportunityResumeFitReviewJob(
        'opportunity',
        f.args,
        f.context,
        subject,
        f.deps,
      ),
    ).rejects.toThrow('terminal failure');
    expect(f.deps.startRun).not.toHaveBeenCalled();
    expect(f.transport).not.toHaveBeenCalled();
  });
  it('stale profile after response retains the actual receipt but refuses persistence and finishes failed', async () => {
    const f = fixture();
    const evaluate = f.deps.evaluate!;
    f.deps.evaluate = vi.fn(
      async (
        ...args: Parameters<
          NonNullable<OpportunityResumeFitReviewJobDependencies['evaluate']>
        >
      ) => {
        const review = await evaluate(...args);
        f.profile.name = 'Changed after provider';
        return review;
      },
    );
    await expect(
      runOpportunityResumeFitReviewJob(
        'opportunity',
        f.args,
        f.context,
        subject,
        f.deps,
      ),
    ).rejects.toThrow('not current');
    expect(f.transport).toHaveBeenCalledOnce();
    expect(f.deps.store).not.toHaveBeenCalled();
    expect(f.deps.finishRun).toHaveBeenCalledWith(
      'sol-run',
      'failed',
      expect.any(String),
      subject,
    );
  });
  it('invalid output failure ends the original run and performs no write', async () => {
    const f = fixture();
    f.deps.evaluate = vi.fn(async () => {
      f.transport();
      throw new Error('Invalid output, usage retained');
    });
    await expect(
      runOpportunityResumeFitReviewJob(
        'opportunity',
        f.args,
        f.context,
        subject,
        f.deps,
      ),
    ).rejects.toThrow('usage retained');
    expect(f.transport).toHaveBeenCalledOnce();
    expect(f.deps.store).not.toHaveBeenCalled();
    expect(f.deps.finishRun).toHaveBeenCalledWith(
      'sol-run',
      'failed',
      expect.any(String),
      subject,
    );
  });
  it('revocation at the provider fence denies transport on the original run', async () => {
    const f = fixture();
    const evaluate: NonNullable<
      OpportunityResumeFitReviewJobDependencies['evaluate']
    > = vi.fn(async (_prepared, options) => {
      mocks.assertOperation.mockRejectedValueOnce(
        new Error('Revoked live permission'),
      );
      await options.revalidateMaterial();
      f.transport();
      return f.review;
    });
    f.deps.evaluate = evaluate;
    await expect(
      runOpportunityResumeFitReviewJob(
        'opportunity',
        f.args,
        f.context,
        subject,
        f.deps,
      ),
    ).rejects.toThrow('Revoked');
    expect(f.transport).not.toHaveBeenCalled();
    expect(f.deps.store).not.toHaveBeenCalled();
    expect(f.deps.finishRun).toHaveBeenCalledWith(
      'sol-run',
      'failed',
      expect.any(String),
      subject,
    );
  });
  it('denies an over-budget full catalog without starting a run or cropping evidence', async () => {
    const f = fixture();
    const preflight = f.deps.preflight!;
    f.deps.preflight = vi.fn(async (...args: Parameters<typeof preflight>) => ({
      ...(await preflight(...args)),
      fits: false,
    }));
    await expect(
      runOpportunityResumeFitReviewJob(
        'opportunity',
        f.args,
        f.context,
        subject,
        f.deps,
      ),
    ).rejects.toThrow('unchanged budget');
    expect(f.deps.startRun).not.toHaveBeenCalled();
    expect(f.transport).not.toHaveBeenCalled();
    expect(f.prepared.requirements).toHaveLength(1);
  });
  it('server captures material and ownership on the dedicated fixed queue', async () => {
    const f = fixture();
    mocks.prepare.mockResolvedValue(f.prepared);
    mocks.read.mockResolvedValue(undefined);
    mocks.preflight.mockResolvedValue({ fits: true });
    mocks.readScreen.mockResolvedValue(f.screen);
    mocks.reviews.mockResolvedValue(new Map());
    mocks.get.mockImplementation(async (name: string) => ({
      toJSON: () => (name === 'Opportunity' ? f.opportunity : f.profile),
    }));
    mocks.enqueue.mockResolvedValue({ id: 'queued' });
    await enqueueOpportunityResumeFitReviewPilot('opportunity');
    expect(mocks.get).toHaveBeenCalledWith(
      'CandidateProfile',
      { id: 'profile' },
      { cache: false },
    );
    expect(mocks.enqueue).toHaveBeenCalledWith(
      expect.objectContaining({
        queue: OPPORTUNITY_RESUME_FIT_REVIEW_PILOT_QUEUE,
        method: 'prepareAssessmentCoverage',
        maxAttempts: 1,
        tenantId: 'tenant',
        args: {
          runtimeWorkspaceSubject: subject,
          resumeFitReview: f.args.resumeFitReview,
        },
      }),
    );
  });
});
