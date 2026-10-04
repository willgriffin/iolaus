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
  OPPORTUNITY_RESUME_FIT_REVIEW_VERSION,
  assertOpportunityResumeFitReviewNotAttempted,
  evaluateOpportunityResumeFitReview,
  prepareCurrentOpportunityResumeFitReview,
  preflightOpportunityResumeFitReview,
  readCurrentOpportunityResumeFitReview,
  readCurrentOpportunityResumeFitReviewReceipt,
  storeOpportunityResumeFitReview,
} from './opportunity-resume-fit-review.js';
import { OPPORTUNITY_SCREENING_VERSION } from './opportunity-screening.js';
import { readCurrentOpportunityAssessmentScreen } from './opportunity-screening-provider.js';
import { candidateProfileWhere } from './private-workspace.js';
import { getCollection } from './smrt.js';

export const OPPORTUNITY_RESUME_FIT_REVIEW_PILOT_QUEUE =
  'opportunity-resume-fit-review';
export const OPPORTUNITY_RESUME_FIT_REVIEW_JOB_CONTRACT =
  'native-opportunity-resume-fit-review/v1';
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
    throw new Error('Resume review native identity is invalid.');
  return value;
}
function sameSubject(
  left: RuntimeWorkspaceSubject,
  right: RuntimeWorkspaceSubject,
) {
  return (
    left.tenantId === right.tenantId &&
    left.userId === right.userId &&
    left.profileId === right.profileId
  );
}
async function nativeRow(
  name: 'Opportunity' | 'CandidateProfile',
  id: string,
): Promise<Row | null> {
  const native = await (await getCollection(name)).get(
    { id },
    { cache: false },
  );
  return native?.toJSON() ?? null;
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
export interface OpportunityResumeFitReviewJobDependencies {
  getOpportunity?: (id: string) => Promise<Row | null>;
  getProfile?: (id: string) => Promise<Row | null>;
  getJob?: (id: string) => Promise<NativeJob | null>;
  runFresh?: typeof runAsRevalidatedJobWorkspaceSubject;
  withLock?: typeof withOpportunityLifecycleLock;
  prepare?: typeof prepareCurrentOpportunityResumeFitReview;
  preflight?: typeof preflightOpportunityResumeFitReview;
  read?: typeof readCurrentOpportunityResumeFitReview;
  readReceipt?: typeof readCurrentOpportunityResumeFitReviewReceipt;
  readScreen?: typeof readCurrentOpportunityAssessmentScreen;
  readReviews?: typeof loadCurrentOpportunityReviewOverlays;
  assertNotAttempted?: typeof assertOpportunityResumeFitReviewNotAttempted;
  evaluate?: typeof evaluateOpportunityResumeFitReview;
  store?: typeof storeOpportunityResumeFitReview;
  startRun?: typeof startOpportunityIntelligenceAgentRun;
  finishRun?: typeof finishOpportunityIntelligenceAgentRun;
}
async function currentMaterial(
  opportunityId: string,
  subject: RuntimeWorkspaceSubject,
  deps: OpportunityResumeFitReviewJobDependencies,
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
      'Resume review requires a current source and active owned profile.',
    );
  const screen = await (
    deps.readScreen ?? readCurrentOpportunityAssessmentScreen
  )({ opportunityId, subject });
  if (
    !screen ||
    screen.screen.version !== OPPORTUNITY_SCREENING_VERSION ||
    screen.outcome !== 'potentially_relevant' ||
    !screen.screen.plausiblyRelevant ||
    screen.screen.holdReasons.length ||
    screen.screen.sourceIdentity.sourceContentFingerprint !==
      opportunity.sourceContentFingerprint ||
    screen.screen.sourceIdentity.sourceContentVersion !==
      opportunity.sourceContentVersion
  )
    throw new Error(
      'Resume review requires a current actual potentially relevant V4 PRIVATE screen.',
    );
  const review = (
    await (deps.readReviews ?? loadCurrentOpportunityReviewOverlays)({
      opportunityIds: [opportunityId],
      subject,
    })
  ).get(opportunityId);
  if (review && ['reject', 'archived'].includes(review.humanReviewStatus))
    throw new Error(
      'The current human review prevents automatic resume review.',
    );
  const prepared = await (
    deps.prepare ?? prepareCurrentOpportunityResumeFitReview
  )(opportunity, subject);
  if (
    prepared.opportunityId !== opportunityId ||
    prepared.sourceContentFingerprint !==
      opportunity.sourceContentFingerprint ||
    prepared.sourceContentVersion !== opportunity.sourceContentVersion
  )
    throw new Error('Resume review source proof is not current.');
  return {
    opportunity,
    prepared,
    intent: {
      contract: OPPORTUNITY_RESUME_FIT_REVIEW_JOB_CONTRACT,
      reviewVersion: OPPORTUNITY_RESUME_FIT_REVIEW_VERSION,
      fingerprint: prepared.fingerprint,
      candidateMaterialFingerprint: prepared.candidateMaterialFingerprint,
      evidenceFingerprint: prepared.evidenceFingerprint,
      sourceContentFingerprint: prepared.sourceContentFingerprint,
      sourceContentVersion: prepared.sourceContentVersion,
      profileRecordFingerprint: hash(profile),
      screeningRequestId: screen.requestId,
      screeningInputFingerprint: screen.inputFingerprint,
    },
  };
}
function sameIntent(value: unknown, expected: Row) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const row = value as Row;
  return (
    Object.keys(row).length === Object.keys(expected).length &&
    Object.entries(expected).every(([key, v]) => row[key] === v)
  );
}

/** Server-owned fixed queue and material; no caller modes, source, catalog or queue flags. */
export async function enqueueOpportunityResumeFitReviewPilot(
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
            throw new Error('Resume review principal changed.');
          await run.assertOperation('opportunities', 'read');
          const material = await currentMaterial(opportunityId, current, {});
          const cached = await readCurrentOpportunityResumeFitReview(
            material.opportunity,
            current,
          );
          if (!cached) {
            await assertOpportunityResumeFitReviewNotAttempted(
              material.prepared,
              current,
            );
            if (
              !(await preflightOpportunityResumeFitReview(material.prepared))
                .fits
            )
              throw new Error(
                'Complete resume review exceeds its unchanged budget.',
              );
          }
          return await (
            await SmrtJobCollection.create(getSmrtOptions())
          ).enqueueJob({
            objectId: opportunityId,
            objectType,
            method,
            queue: OPPORTUNITY_RESUME_FIT_REVIEW_PILOT_QUEUE,
            tenantId: current.tenantId,
            maxAttempts: 1,
            timeout: 3 * 60 * 1000,
            priority: 80,
            args: { ...args, resumeFitReview: material.intent },
          });
        },
      ),
  );
}

/** Authentic native execution: exactly one Sol request or actual receipt replay. */
export async function runOpportunityResumeFitReviewJob(
  opportunityId: string,
  args: Row,
  context: JobExecutionContext,
  subject: RuntimeWorkspaceSubject,
  deps: OpportunityResumeFitReviewJobDependencies = {},
) {
  identity(opportunityId);
  const runner = requireActiveRunnerExecutionContext(context);
  if (
    runner.job.queue !== OPPORTUNITY_RESUME_FIT_REVIEW_PILOT_QUEUE ||
    runner.job.method !== method ||
    runner.job.objectType !== objectType ||
    runner.job.tenantId !== subject.tenantId
  )
    throw new Error(
      'Resume review requires its authentic dedicated native job.',
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
          throw new Error('Resume review principal changed.');
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
            job.queue !== OPPORTUNITY_RESUME_FIT_REVIEW_PILOT_QUEUE ||
            !sameSubject(
              runtimeWorkspaceSubjectFromJobArgs(job.args),
              subject,
            ) ||
            !sameSubject(runtimeWorkspaceSubjectFromJobArgs(args), subject)
          )
            throw new Error('Resume review durable authority is not current.');
          const material = await currentMaterial(opportunityId, subject, deps);
          if (
            !sameIntent(args.resumeFitReview, material.intent) ||
            !sameIntent(job.args.resumeFitReview, material.intent) ||
            [
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
              'Resume review durable material or intent is not current.',
            );
          return material;
        });
      const read = deps.read ?? readCurrentOpportunityResumeFitReview;
      const material = await assertCurrent();
      const cached = await read(material.opportunity, subject);
      if (cached) {
        const current = await assertCurrent();
        const confirmed = await read(current.opportunity, subject);
        if (
          !confirmed ||
          hash(cached) !== hash(confirmed) ||
          cached.fingerprint !== current.prepared.fingerprint
        )
          throw new Error(
            'Resume review cached PRIVATE receipt is not current.',
          );
        return {
          status: 'reviewed',
          stage: 'resume_fit_review',
          reused: true,
          review: confirmed,
        };
      }
      await (
        deps.assertNotAttempted ?? assertOpportunityResumeFitReviewNotAttempted
      )(material.prepared, subject);
      if (
        !(
          await (deps.preflight ?? preflightOpportunityResumeFitReview)(
            material.prepared,
          )
        ).fits
      )
        throw new Error('Complete resume review exceeds its unchanged budget.');
      await assertCurrent();
      const agentRunId = await (
        deps.startRun ?? startOpportunityIntelligenceAgentRun
      )({ opportunityId, workspaceSubject: subject });
      try {
        const before = await assertCurrent();
        const review = await (
          deps.evaluate ?? evaluateOpportunityResumeFitReview
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
          deps.readReceipt ?? readCurrentOpportunityResumeFitReviewReceipt
        )(current.opportunity, subject);
        if (
          !actual ||
          actual.agentRunId !== agentRunId ||
          hash(actual) !== hash(review) ||
          actual.fingerprint !== current.prepared.fingerprint
        )
          throw new Error(
            'Resume review completion lacks its current actual PRIVATE receipt.',
          );
        await fresh(async () => {
          const current = await assertCurrent();
          await (deps.store ?? storeOpportunityResumeFitReview)({
            prepared: current.prepared,
            result: actual,
            opportunity: current.opportunity,
            subject,
            agentRunId,
          });
        });
        const publishedMaterial = await assertCurrent();
        const published = await read(publishedMaterial.opportunity, subject);
        if (!published || hash(published) !== hash(actual))
          throw new Error(
            'Resume review has no current published PRIVATE assessment.',
          );
        await (deps.finishRun ?? finishOpportunityIntelligenceAgentRun)(
          agentRunId,
          'succeeded',
          '',
          subject,
        );
        return {
          status: 'reviewed',
          stage: 'resume_fit_review',
          reused: false,
          review: actual,
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
