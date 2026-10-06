import { createHash } from 'node:crypto';
import {
  type JobExecutionContext,
  type SmrtJob,
  SmrtJobCollection,
} from '@happyvertical/smrt-jobs';
import { withOpportunityLifecycleLock } from './application-workflow.js';
import { getSmrtOptions } from './db.js';
import {
  type RuntimeWorkspaceSubject,
  requireActiveRunnerExecutionContext,
  runAsRevalidatedJobWorkspaceSubject,
  runtimeWorkspaceSubjectFromJobArgs,
  withRuntimeWorkspaceSubject,
} from './job-workspace-subject.js';
import {
  finishOpportunityIntelligenceAgentRun,
  startOpportunityIntelligenceAgentRun,
} from './opportunity-intelligence-governance.js';
import { loadCurrentOpportunityReviewOverlays } from './opportunity-review-overlay.js';
import {
  assertOpportunityReviewStrengthVerificationNotAttempted,
  evaluateOpportunityReviewStrengthVerification,
  OPPORTUNITY_REVIEW_STRENGTH_VERIFICATION_MODEL,
  OPPORTUNITY_REVIEW_STRENGTH_VERIFICATION_V1_VERSION,
  OPPORTUNITY_REVIEW_STRENGTH_VERIFICATION_VERSION,
  type OpportunityReviewStrengthVerificationOptions,
  type OpportunityReviewStrengthVerificationResult,
  type PreparedOpportunityReviewStrengthVerification,
  preflightOpportunityReviewStrengthVerification,
  prepareCurrentOpportunityReviewStrengthVerification,
  readCurrentOpportunityReviewStrengthVerification,
  readCurrentOpportunityReviewStrengthVerificationReceipt,
  storeOpportunityReviewStrengthVerification,
} from './opportunity-review-strength-verification.js';
import { candidateProfileWhere } from './private-workspace.js';
import { getCollection } from './smrt.js';

export const OPPORTUNITY_REVIEW_STRENGTH_VERIFICATION_QUEUE =
  'opportunity-review-strength-verification';
export const OPPORTUNITY_REVIEW_STRENGTH_VERIFICATION_JOB_CONTRACT =
  'native-opportunity-review-strength-verification/v1';
const method = 'prepareAssessmentCoverage';
const objectType = '@willgriffin/iolaus-site:Opportunity';
type Row = Record<string, unknown>;
const hash = (value: unknown) =>
  createHash('sha256').update(JSON.stringify(value)).digest('hex');
function identity(value: unknown): string {
  if (
    typeof value !== 'string' ||
    !value ||
    value !== value.trim() ||
    value.length > 200 ||
    [...value].some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127)
  )
    throw new Error('Review verification native identity is invalid.');
  return value;
}
const sameSubject = (
  left: RuntimeWorkspaceSubject,
  right: RuntimeWorkspaceSubject,
) =>
  left.tenantId === right.tenantId &&
  left.userId === right.userId &&
  left.profileId === right.profileId;
async function nativeRow(
  name: 'Opportunity' | 'CandidateProfile',
  id: string,
): Promise<Row | null> {
  return (
    (
      await (await getCollection(name)).get({ id }, { cache: false })
    )?.toJSON() ?? null
  );
}
type NativeJob = Pick<
  SmrtJob,
  | 'id'
  | 'status'
  | 'attempts'
  | 'maxAttempts'
  | 'tenantId'
  | 'objectId'
  | 'objectType'
  | 'queue'
  | 'method'
  | 'args'
>;
export interface OpportunityReviewStrengthVerificationJobDependencies {
  getOpportunity?: (id: string) => Promise<Row | null>;
  getProfile?: (id: string) => Promise<Row | null>;
  getJob?: (id: string) => Promise<NativeJob | null>;
  runFresh?: typeof runAsRevalidatedJobWorkspaceSubject;
  withLock?: typeof withOpportunityLifecycleLock;
  prepare?: typeof prepareCurrentOpportunityReviewStrengthVerification;
  preflight?: typeof preflightOpportunityReviewStrengthVerification;
  read?: typeof readCurrentOpportunityReviewStrengthVerification;
  readReceipt?: typeof readCurrentOpportunityReviewStrengthVerificationReceipt;
  readReviews?: typeof loadCurrentOpportunityReviewOverlays;
  assertNotAttempted?: typeof assertOpportunityReviewStrengthVerificationNotAttempted;
  evaluate?: typeof evaluateOpportunityReviewStrengthVerification;
  store?: typeof storeOpportunityReviewStrengthVerification;
  startRun?: typeof startOpportunityIntelligenceAgentRun;
  finishRun?: typeof finishOpportunityIntelligenceAgentRun;
}
async function currentMaterial(
  opportunityId: string,
  subject: RuntimeWorkspaceSubject,
  deps: OpportunityReviewStrengthVerificationJobDependencies,
  options: OpportunityReviewStrengthVerificationOptions = {},
) {
  const opportunity = await (
    deps.getOpportunity ?? ((id) => nativeRow('Opportunity', id))
  )(opportunityId);
  const profile = await (
    deps.getProfile ?? ((id) => nativeRow('CandidateProfile', id))
  )(subject.profileId);
  if (
    !opportunity ||
    opportunity.id !== opportunityId ||
    !profile ||
    profile.id !== subject.profileId ||
    profile.active !== true ||
    Object.entries(candidateProfileWhere(subject)).some(
      ([key, value]) => profile[key] !== value,
    )
  )
    throw new Error(
      'Review verification requires current source and active owned profile.',
    );
  const review = (
    await (deps.readReviews ?? loadCurrentOpportunityReviewOverlays)({
      opportunityIds: [opportunityId],
      subject,
    })
  ).get(opportunityId);
  if (review && ['reject', 'archived'].includes(review.humanReviewStatus))
    throw new Error(
      'The current human review prevents automatic strength verification.',
    );
  const prepared = await (
    deps.prepare ?? prepareCurrentOpportunityReviewStrengthVerification
  )(opportunity, subject, options);
  const original = prepared.originalReview;
  if (
    prepared.version !==
      (options.version ?? OPPORTUNITY_REVIEW_STRENGTH_VERIFICATION_VERSION) ||
    prepared.model !== OPPORTUNITY_REVIEW_STRENGTH_VERIFICATION_MODEL ||
    prepared.opportunityId !== opportunityId ||
    prepared.reviewFingerprint !== original.fingerprint ||
    prepared.candidateMaterialFingerprint !==
      original.candidateMaterialFingerprint ||
    original.model !== 'openai/gpt-6.1-sol' ||
    original.contractVersion !==
      'opportunity-resume-fit-review/v4-complete-material' ||
    original.sourceContentFingerprint !==
      opportunity.sourceContentFingerprint ||
    original.sourceContentVersion !== opportunity.sourceContentVersion
  )
    throw new Error(
      'Review verification requires its current saved actual Sol/V4 review.',
    );
  return {
    opportunity,
    prepared,
    intent: {
      contract: OPPORTUNITY_REVIEW_STRENGTH_VERIFICATION_JOB_CONTRACT,
      materialFingerprint: hash(prepared),
      verificationVersion: prepared.version,
      verificationModel: prepared.model,
      verificationFingerprint: prepared.fingerprint,
      originalReviewRequestId: original.requestId,
      originalReviewInputFingerprint: original.inputFingerprint,
      originalReviewFingerprint: original.fingerprint,
      sourceContentFingerprint: original.sourceContentFingerprint,
      sourceContentVersion: original.sourceContentVersion,
      candidateMaterialFingerprint: original.candidateMaterialFingerprint,
      profileRecordFingerprint: hash(profile),
    },
  };
}
function sameIntent(value: unknown, expected: Row) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const actual = value as Row;
  return (
    Object.keys(actual).length === Object.keys(expected).length &&
    Object.entries(expected).every(([key, v]) => actual[key] === v)
  );
}
function resultMatches(
  prepared: PreparedOpportunityReviewStrengthVerification,
  result: OpportunityReviewStrengthVerificationResult,
) {
  return (
    result.contractVersion === prepared.version &&
    result.model === prepared.model &&
    result.mode === 'independent_strength_verification' &&
    result.fingerprint === prepared.fingerprint &&
    result.reviewFingerprint === prepared.reviewFingerprint &&
    hash(result.originalReview) === hash(prepared.originalReview)
  );
}
/** Fixed server-created PRIVATE verification of an already saved Sol review. */
export async function enqueueOpportunityReviewStrengthVerificationPilot(
  opportunityId: string,
): Promise<SmrtJob> {
  identity(opportunityId);
  const args = withRuntimeWorkspaceSubject({});
  const subject = runtimeWorkspaceSubjectFromJobArgs(args);
  return await withOpportunityLifecycleLock(
    opportunityId,
    async () =>
      await runAsRevalidatedJobWorkspaceSubject(
        subject,
        'assessment.execute',
        async (current, run) => {
          if (!sameSubject(current, subject))
            throw new Error('Review verification principal changed.');
          await run.assertOperation('opportunities', 'read');
          const material = await currentMaterial(opportunityId, current, {});
          if (
            !(await readCurrentOpportunityReviewStrengthVerification(
              material.opportunity,
              current,
            ))
          ) {
            await assertOpportunityReviewStrengthVerificationNotAttempted(
              material.prepared,
              current,
            );
            if (
              !(
                await preflightOpportunityReviewStrengthVerification(
                  material.prepared,
                )
              ).fits
            )
              throw new Error(
                'Review verification exceeds its unchanged budget.',
              );
          }
          return await (
            await SmrtJobCollection.create(getSmrtOptions())
          ).enqueueJob({
            objectId: opportunityId,
            objectType,
            method,
            queue: OPPORTUNITY_REVIEW_STRENGTH_VERIFICATION_QUEUE,
            tenantId: current.tenantId,
            maxAttempts: 1,
            timeout: 3 * 60 * 1000,
            priority: 80,
            args: { ...args, reviewStrengthVerification: material.intent },
          });
        },
      ),
  );
}
/** Exactly one governed JEV request or an actual current verifier receipt replay. */
export async function runOpportunityReviewStrengthVerificationJob(
  opportunityId: string,
  args: Row,
  context: JobExecutionContext,
  subject: RuntimeWorkspaceSubject,
  deps: OpportunityReviewStrengthVerificationJobDependencies = {},
) {
  identity(opportunityId);
  const runner = requireActiveRunnerExecutionContext(context);
  const captured = args.reviewStrengthVerification as Row | undefined;
  const version = captured?.verificationVersion;
  if (
    version !== OPPORTUNITY_REVIEW_STRENGTH_VERIFICATION_VERSION &&
    version !== OPPORTUNITY_REVIEW_STRENGTH_VERIFICATION_V1_VERSION
  )
    throw new Error(
      'Review verification requires its exact supported captured contract.',
    );
  const options: OpportunityReviewStrengthVerificationOptions = { version };

  if (
    runner.job.queue !== OPPORTUNITY_REVIEW_STRENGTH_VERIFICATION_QUEUE ||
    runner.job.method !== method ||
    runner.job.objectType !== objectType ||
    runner.job.tenantId !== subject.tenantId
  )
    throw new Error(
      'Review verification requires its authentic dedicated native job.',
    );
  const getJob =
    deps.getJob ??
    (async (id: string) =>
      await (await SmrtJobCollection.create(getSmrtOptions())).get(
        { id },
        { cache: false },
      ));
  const fresh = async <T>(work: () => Promise<T>) =>
    await (deps.runFresh ?? runAsRevalidatedJobWorkspaceSubject)(
      subject,
      'assessment.execute',
      async (current, run) => {
        if (!sameSubject(current, subject))
          throw new Error('Review verification principal changed.');
        await run.assertOperation('opportunities', 'read');
        return await work();
      },
    );
  return await (deps.withLock ?? withOpportunityLifecycleLock)(
    opportunityId,
    async () => {
      const assertCurrent = async () =>
        await fresh(async () => {
          const job = await getJob(identity(runner.job.jobId));
          if (
            !job ||
            job.id !== runner.job.jobId ||
            job.status !== 'running' ||
            job.attempts !== runner.job.attempt ||
            job.maxAttempts !== 1 ||
            job.tenantId !== subject.tenantId ||
            job.objectId !== opportunityId ||
            job.objectType !== objectType ||
            job.method !== method ||
            job.queue !== OPPORTUNITY_REVIEW_STRENGTH_VERIFICATION_QUEUE ||
            !sameSubject(
              runtimeWorkspaceSubjectFromJobArgs(job.args),
              subject,
            ) ||
            !sameSubject(runtimeWorkspaceSubjectFromJobArgs(args), subject)
          )
            throw new Error(
              'Review verification durable authority is not current.',
            );
          const material = await currentMaterial(
            opportunityId,
            subject,
            deps,
            options,
          );
          if (
            !sameIntent(args.reviewStrengthVerification, material.intent) ||
            !sameIntent(job.args.reviewStrengthVerification, material.intent) ||
            [
              'resumeFitReview',
              'sourceCoverageStage',
              'sourceCoverageRepair',
              'screeningOnly',
              'assessmentCoverageContract',
              'assessmentPilot',
              'modes',
            ].some(
              (key) => args[key] !== undefined || job.args[key] !== undefined,
            )
          )
            throw new Error(
              'Review verification durable material or intent is not current.',
            );
          return material;
        });
      const read =
        deps.read ?? readCurrentOpportunityReviewStrengthVerification;
      const material = await assertCurrent();
      const cached = await read(material.opportunity, subject, options);
      if (cached) {
        const current = await assertCurrent();
        const confirmed = await read(current.opportunity, subject, options);
        if (
          !confirmed ||
          !resultMatches(current.prepared, cached) ||
          !resultMatches(current.prepared, confirmed) ||
          hash(cached) !== hash(confirmed)
        )
          throw new Error(
            'Review verification cached PRIVATE receipt is not current.',
          );
        return {
          status: 'verified',
          stage: 'review_strength_verification',
          reused: true,
          verification: confirmed,
        };
      }
      await (
        deps.assertNotAttempted ??
        assertOpportunityReviewStrengthVerificationNotAttempted
      )(material.prepared, subject);
      if (
        !(
          await (
            deps.preflight ?? preflightOpportunityReviewStrengthVerification
          )(material.prepared)
        ).fits
      )
        throw new Error('Review verification exceeds its unchanged budget.');
      await assertCurrent();
      const agentRunId = await (
        deps.startRun ?? startOpportunityIntelligenceAgentRun
      )({ opportunityId, workspaceSubject: subject });
      try {
        const before = await assertCurrent();
        const verification = await (
          deps.evaluate ?? evaluateOpportunityReviewStrengthVerification
        )(before.prepared, {
          opportunity: before.opportunity,
          subject,
          agentRunId,
          signal: AbortSignal.timeout(3 * 60 * 1000),
          revalidateMaterial: async () => {
            await assertCurrent();
          },
        });
        const current = await assertCurrent();
        const actual = await (
          deps.readReceipt ??
          readCurrentOpportunityReviewStrengthVerificationReceipt
        )(current.opportunity, subject, options);
        if (
          !actual ||
          !resultMatches(current.prepared, actual) ||
          actual.agentRunId !== agentRunId ||
          hash(actual) !== hash(verification)
        )
          throw new Error(
            'Review verification completion lacks its current actual PRIVATE receipt.',
          );
        await fresh(async () => {
          const current = await assertCurrent();
          await (deps.store ?? storeOpportunityReviewStrengthVerification)({
            prepared: current.prepared,
            result: actual,
            opportunity: current.opportunity,
            subject,
            agentRunId,
          });
        });
        const publishedMaterial = await assertCurrent();
        const published = await read(
          publishedMaterial.opportunity,
          subject,
          options,
        );
        if (
          !published ||
          !resultMatches(publishedMaterial.prepared, published) ||
          hash(published) !== hash(actual)
        )
          throw new Error(
            'Review verification has no current published PRIVATE result.',
          );
        await (deps.finishRun ?? finishOpportunityIntelligenceAgentRun)(
          agentRunId,
          'succeeded',
          '',
          subject,
        );
        return {
          status: 'verified',
          stage: 'review_strength_verification',
          reused: false,
          verification: actual,
        };
      } catch (error) {
        await (deps.finishRun ?? finishOpportunityIntelligenceAgentRun)(
          agentRunId,
          'failed',
          error instanceof Error ? error.message : String(error),
          subject,
        );
        throw error;
      }
    },
  );
}
