import { createHash } from 'node:crypto';
import type { PrincipalRun } from '@happyvertical/smrt-agents';
import type { JobExecutionContext } from '@happyvertical/smrt-jobs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { summarizeCompleteReviewEvidence } from './opportunity-assessment-completeness.js';
import type {
  OpportunityResumeFitReviewResult,
  PreparedOpportunityResumeFitReview,
} from './opportunity-resume-fit-review.js';
import {
  OPPORTUNITY_REVIEW_STRENGTH_VERIFICATION_MODEL,
  OPPORTUNITY_REVIEW_STRENGTH_VERIFICATION_V1_VERSION,
  OPPORTUNITY_REVIEW_STRENGTH_VERIFICATION_VERSION,
  type OpportunityReviewStrengthVerificationVersion,
  prepareOpportunityReviewStrengthVerification,
  resolveOpportunityReviewStrengthVerification,
} from './opportunity-review-strength-verification.js';
import {
  OPPORTUNITY_REVIEW_STRENGTH_VERIFICATION_JOB_CONTRACT,
  OPPORTUNITY_REVIEW_STRENGTH_VERIFICATION_QUEUE,
  type OpportunityReviewStrengthVerificationJobDependencies,
  runOpportunityReviewStrengthVerificationJob,
} from './opportunity-review-strength-verification-job.js';

const mocks = vi.hoisted(() => ({
  active: undefined as unknown,
  assertOperation: vi.fn(),
}));
vi.mock('./db.js', () => ({
  getSmrtOptions: () => ({}),
  getDbConfig: () => ({}),
}));
vi.mock('./job-workspace-subject.js', () => ({
  requireActiveRunnerExecutionContext: (context: unknown) => {
    if (context !== mocks.active) throw new Error('Not active runner');
    return context;
  },
  runtimeWorkspaceSubjectFromJobArgs: (args: Record<string, unknown>) =>
    args.runtimeWorkspaceSubject,
}));
const subject = { tenantId: 'tenant', userId: 'user', profileId: 'profile' };
const hash = (value: unknown) =>
  createHash('sha256').update(JSON.stringify(value)).digest('hex');
type NativeJob = NonNullable<
  Awaited<
    ReturnType<
      NonNullable<
        OpportunityReviewStrengthVerificationJobDependencies['getJob']
      >
    >
  >
>;
function fixture(
  probability = 0.9,
  asserted = true,
  version: OpportunityReviewStrengthVerificationVersion = OPPORTUNITY_REVIEW_STRENGTH_VERIFICATION_VERSION,
  partialProbability = probability,
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
  };
  const criterion = '3+ years of software development';
  const fact = 'Developed software in dated employment from 2020 to 2024.';
  const row: OpportunityResumeFitReviewResult['requirements'][number] = {
    id: 'material:source-field:criterion',
    text: criterion,
    sourceClassification: 'possible_requirement_unknown',
    sourceDisposition: 'criterion',
    status: asserted ? 'strength' : 'uncertain',
    seniority: asserted ? 'supported' : 'uncertain',
    note: 'Explicit dated support',
    candidateCitations: [
      {
        sourceId: 'employment',
        title: 'Employment',
        kind: 'employment',
        start: 0,
        end: fact.length,
        quote: fact,
        citationMode: 'whole_fact',
      },
    ],
    postingCitations: [
      {
        clauseId: 'source-field:criterion',
        start: 0,
        end: criterion.length,
        quote: criterion,
        sourceFieldPath: 'locationNotes',
        citationMode: 'whole_field',
      },
    ],
  };
  const evidenceFit = summarizeCompleteReviewEvidence([
    {
      status: row.status,
      sourceDisposition: 'criterion',
      sourceClassification: 'possible_requirement_unknown',
    },
  ]);
  const original: OpportunityResumeFitReviewResult = {
    contractVersion: 'opportunity-resume-fit-review/v4-complete-material',
    mode: 'complete_material',
    requestId: 'saved-sol',
    agentRunId: 'saved-sol-run',
    inputFingerprint: 'saved-sol-input',
    fingerprint: 'saved-sol-material',
    candidateMaterialFingerprint: 'complete-owned-catalog',
    evidenceFingerprint: 'complete-source',
    sourceContentFingerprint: 'source-fp',
    sourceContentVersion: 1,
    model: 'openai/gpt-6.1-sol',
    provider: 'bifrost',
    evidenceFit,
    coverage: {
      candidateSourceCount: 1,
      reviewedRequirementIds: [row.id],
      unresolvedClauseIds: ['source-field:criterion'],
      sourceComplete: true,
      fullFit: evidenceFit,
      consideredComplete: true,
      completion: {
        status: 'reviewed_with_unknowns',
        consideredComplete: true,
        catalogClauseCount: 1,
        reviewedMaterialClauseCount: 1,
        possibleRequirementCount: 1,
        unprocessedClauseIds: [],
        issues: [],
        evidenceFit,
      },
    },
    requirements: [row],
  };
  const reviewPrepared: PreparedOpportunityResumeFitReview = {
    version: original.contractVersion,
    model: 'openai/gpt-6.1-sol',
    opportunityId: 'opportunity',
    fingerprint: original.fingerprint,
    candidateMaterialFingerprint: original.candidateMaterialFingerprint,
    evidenceFingerprint: original.evidenceFingerprint,
    sourceContentFingerprint: 'source-fp',
    sourceContentVersion: 1,
    messages: [],
    candidates: [
      {
        id: 'employment',
        key: 'c0',
        kind: 'employment',
        title: 'Employment',
        text: fact,
      },
    ],
    clauses: [],
    capturedFields: [
      {
        id: 'source-field:criterion',
        key: 'f0',
        path: 'locationNotes',
        text: criterion,
        hash: 'field-hash',
        bodyClauseIds: [],
      },
    ],
    requirements: [
      { id: row.id, key: 'r0', text: criterion, clauseKeys: ['f0'] },
    ],
    unresolvedClauseIds: ['source-field:criterion'],
    sourceComplete: true,
    outputShapeBytes: 1,
    maximumSerializedOutput: '{}',
    visibleOutputTokens: 2048,
    reasoningTokens: 1024,
  };
  const prepared = prepareOpportunityReviewStrengthVerification(
    { review: original, reviewPrepared },
    { version },
  );
  const result = asserted
    ? resolveOpportunityReviewStrengthVerification(
        prepared,
        {
          model: OPPORTUNITY_REVIEW_STRENGTH_VERIFICATION_MODEL,
          provenance: {
            provider: 'typesafe',
            model: OPPORTUNITY_REVIEW_STRENGTH_VERIFICATION_MODEL,
          },
          answers: Object.fromEntries(
            Object.keys(prepared.bindings).map((key) => [
              key,
              {
                type: 'predicate',
                probability:
                  prepared.bindings[key]?.dimension === 'partial_relevance'
                    ? partialProbability
                    : probability,
              },
            ]),
          ),
        },
        'actual-jev',
        'actual-private-input',
        'verification-run',
      )
    : undefined;
  const intent = {
    contract: OPPORTUNITY_REVIEW_STRENGTH_VERIFICATION_JOB_CONTRACT,
    materialFingerprint: hash(prepared),
    verificationVersion: prepared.version,
    verificationModel: prepared.model,
    verificationFingerprint: prepared.fingerprint,
    originalReviewRequestId: original.requestId,
    originalReviewInputFingerprint: original.inputFingerprint,
    originalReviewFingerprint: original.fingerprint,
    sourceContentFingerprint: original.sourceContentFingerprint,
    sourceContentVersion: 1,
    candidateMaterialFingerprint: original.candidateMaterialFingerprint,
    profileRecordFingerprint: hash(profile),
  };
  const args: Record<string, unknown> = {
    runtimeWorkspaceSubject: subject,
    reviewStrengthVerification: intent,
  };
  const context = {
    job: {
      jobId: 'job',
      attempt: 1,
      tenantId: 'tenant',
      objectType: '@willgriffin/iolaus-site:Opportunity',
      method: 'prepareAssessmentCoverage',
      queue: OPPORTUNITY_REVIEW_STRENGTH_VERIFICATION_QUEUE,
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
      throw new Error('No tool');
    },
    assertOperation: mocks.assertOperation,
  };
  const runFresh: NonNullable<
    OpportunityReviewStrengthVerificationJobDependencies['runFresh']
  > = async <T>(
    current: typeof subject,
    _capability: Parameters<
      NonNullable<
        OpportunityReviewStrengthVerificationJobDependencies['runFresh']
      >
    >[1],
    work: (current: typeof subject, run: PrincipalRun) => Promise<T>,
  ) => await work(current, principal);
  let actual: typeof result;
  let published = false;
  const transport = vi.fn();
  const evaluate: NonNullable<
    OpportunityReviewStrengthVerificationJobDependencies['evaluate']
  > = vi.fn(async (_prepared, options) => {
    await options.revalidateMaterial();
    transport();
    if (!result) throw new Error('No claims');
    actual = result;
    await options.revalidateMaterial();
    return result;
  });
  const deps: OpportunityReviewStrengthVerificationJobDependencies = {
    getOpportunity: vi.fn(async () => opportunity),
    getProfile: vi.fn(async () => profile),
    getJob: vi.fn(async () => job),
    runFresh,
    withLock: async <T>(_id: string, work: () => Promise<T>) => await work(),
    prepare: vi.fn(async () => prepared),
    preflight: vi.fn(() => ({
      requestBytes: 1000,
      inputTokenCeiling: 1000,
      maxOutputTokens: 100,
      reservedTokens: 1100,
      spendMicros: 100,
      calls: 1,
      fits: true,
    })),
    read: vi.fn(async () => (published ? actual : undefined)),
    readReceipt: vi.fn(async () => actual),
    readReviews: vi.fn(async () => new Map()),
    assertNotAttempted: vi.fn(async () => {}),
    evaluate,
    store: vi.fn(async () => {
      published = true;
      return true;
    }),
    startRun: vi.fn(async () => 'verification-run'),
    finishRun: vi.fn(async () => {}),
  };
  return {
    opportunity,
    profile,
    original,
    prepared,
    result,
    args,
    context,
    job,
    deps,
    transport,
    reuse: () => {
      actual = result;
      published = true;
    },
  };
}
beforeEach(() => vi.clearAllMocks());
describe('native independent saved-review verification', () => {
  it('runs one JEV and publishes its actual receipt while preserving the saved Sol review', async () => {
    const f = fixture(0.4);
    const old = structuredClone(f.original);
    await expect(
      runOpportunityReviewStrengthVerificationJob(
        'opportunity',
        f.args,
        f.context,
        subject,
        f.deps,
      ),
    ).resolves.toMatchObject({
      status: 'verified',
      reused: false,
      verification: {
        requirements: [{ status: 'uncertain', seniority: 'uncertain' }],
      },
    });
    expect(f.transport).toHaveBeenCalledOnce();
    expect(f.deps.startRun).toHaveBeenCalledOnce();
    expect(f.deps.store).toHaveBeenCalledWith(
      expect.objectContaining({
        result: f.result,
        agentRunId: 'verification-run',
      }),
    );
    expect(f.original).toEqual(old);
  });
  it('reuses the actual published verifier with zero provider, new run or write', async () => {
    const f = fixture();
    f.reuse();
    await expect(
      runOpportunityReviewStrengthVerificationJob(
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
  it.each([
    'queue',
    'owner',
    'source',
    'profile',
    'original',
    'mixed',
  ])('denies %s before a provider or new run', async (cause) => {
    const f = fixture();
    if (cause === 'queue')
      f.context.job.queue = 'opportunity-resume-fit-review';
    if (cause === 'owner') f.job.tenantId = 'foreign';
    if (cause === 'source') f.opportunity.sourceContentVersion = 2;
    if (cause === 'profile') f.profile.active = false;
    if (cause === 'original')
      f.prepared.originalReview.inputFingerprint = 'changed';
    if (cause === 'mixed') f.args.resumeFitReview = {};
    await expect(
      runOpportunityReviewStrengthVerificationJob(
        'opportunity',
        f.args,
        f.context,
        subject,
        f.deps,
      ),
    ).rejects.toThrow();
    expect(f.transport).not.toHaveBeenCalled();
    expect(f.deps.startRun).not.toHaveBeenCalled();
  });
  it('refuses a failed same identity before another run', async () => {
    const f = fixture();
    f.deps.assertNotAttempted = vi.fn(async () => {
      throw new Error('Recorded attempt');
    });
    await expect(
      runOpportunityReviewStrengthVerificationJob(
        'opportunity',
        f.args,
        f.context,
        subject,
        f.deps,
      ),
    ).rejects.toThrow('Recorded attempt');
    expect(f.transport).not.toHaveBeenCalled();
    expect(f.deps.startRun).not.toHaveBeenCalled();
  });
  it('denies a missing actual receipt after response without publishing', async () => {
    const f = fixture();
    f.deps.readReceipt = vi.fn(async () => undefined);
    await expect(
      runOpportunityReviewStrengthVerificationJob(
        'opportunity',
        f.args,
        f.context,
        subject,
        f.deps,
      ),
    ).rejects.toThrow('actual PRIVATE');
    expect(f.transport).toHaveBeenCalledOnce();
    expect(f.deps.store).not.toHaveBeenCalled();
    expect(f.deps.finishRun).toHaveBeenCalledWith(
      'verification-run',
      'failed',
      expect.any(String),
      subject,
    );
  });
  it('fresh permission revocation inside provider fence denies transport', async () => {
    const f = fixture();
    f.deps.evaluate = vi.fn(async (_prepared, options) => {
      mocks.assertOperation.mockRejectedValueOnce(new Error('Revoked'));
      await options.revalidateMaterial();
      f.transport();
      return f.result!;
    });
    await expect(
      runOpportunityReviewStrengthVerificationJob(
        'opportunity',
        f.args,
        f.context,
        subject,
        f.deps,
      ),
    ).rejects.toThrow('Revoked');
    expect(f.transport).not.toHaveBeenCalled();
    expect(f.deps.store).not.toHaveBeenCalled();
  });
  it('source changes after actual completion retain the receipt and prevent publication', async () => {
    const f = fixture();
    const evaluate = f.deps.evaluate!;
    f.deps.evaluate = vi.fn(async (...args: Parameters<typeof evaluate>) => {
      const actual = await evaluate(...args);
      f.opportunity.sourceContentVersion = 2;
      return actual;
    });
    await expect(
      runOpportunityReviewStrengthVerificationJob(
        'opportunity',
        f.args,
        f.context,
        subject,
        f.deps,
      ),
    ).rejects.toThrow('current');
    expect(f.transport).toHaveBeenCalledOnce();
    expect(f.deps.store).not.toHaveBeenCalled();
  });
  it('publishes partial support separately without upgrading strict strength or tenure', async () => {
    const f = fixture(
      0.4,
      true,
      OPPORTUNITY_REVIEW_STRENGTH_VERIFICATION_VERSION,
      0.9,
    );
    await expect(
      runOpportunityReviewStrengthVerificationJob(
        'opportunity',
        f.args,
        f.context,
        subject,
        f.deps,
      ),
    ).resolves.toMatchObject({
      verification: {
        requirements: [{ status: 'uncertain', seniority: 'uncertain' }],
        verification: {
          verifiedStrengthCount: 0,
          verifiedSeniorityCount: 0,
          verifiedPartialCount: 1,
          partialSupportedRequirementIds: [f.original.requirements[0]!.id],
        },
      },
    });
    expect(f.transport).toHaveBeenCalledOnce();
    expect(f.result?.originalReview).toEqual(f.original);
    expect(f.deps.store).toHaveBeenCalledOnce();
  });
  it('replays the exact historical V1 verifier without a new provider or current-V2 request', async () => {
    const f = fixture(
      0.9,
      true,
      OPPORTUNITY_REVIEW_STRENGTH_VERIFICATION_V1_VERSION,
    );
    f.reuse();
    await expect(
      runOpportunityReviewStrengthVerificationJob(
        'opportunity',
        f.args,
        f.context,
        subject,
        f.deps,
      ),
    ).resolves.toMatchObject({
      reused: true,
      verification: {
        contractVersion: OPPORTUNITY_REVIEW_STRENGTH_VERIFICATION_V1_VERSION,
      },
    });
    expect(f.deps.prepare).toHaveBeenCalledWith(f.opportunity, subject, {
      version: OPPORTUNITY_REVIEW_STRENGTH_VERIFICATION_V1_VERSION,
    });
    expect(f.deps.read).toHaveBeenCalledWith(f.opportunity, subject, {
      version: OPPORTUNITY_REVIEW_STRENGTH_VERIFICATION_V1_VERSION,
    });
    expect(f.transport).not.toHaveBeenCalled();
    expect(f.deps.startRun).not.toHaveBeenCalled();
  });
});
