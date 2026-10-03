import { createHash } from 'node:crypto';
import type { PrincipalRun } from '@happyvertical/smrt-agents';
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
import {
  OPPORTUNITY_SCREENING_VERSION,
  type PreparedOpportunityScreening,
} from './opportunity-screening.js';
import {
  assertOpportunityAssessmentScreenNotAttempted,
  type CurrentOpportunityAssessmentScreen,
  evaluateOpportunityAssessmentScreen,
  prepareCurrentOpportunityAssessmentScreen,
  readCurrentOpportunityAssessmentScreen,
} from './opportunity-screening-provider.js';

export const OPPORTUNITY_SCREENING_ONLY_JOB_CONTRACT =
  'native-opportunity-screening-only/v1';
const nativeMethod = 'prepareAssessmentCoverage';
export const OPPORTUNITY_SCREENING_ONLY_QUEUE = 'opportunity-screening';
const nativeObject = '@willgriffin/iolaus-site:Opportunity';
type Args = Record<string, unknown>;

function identity(value: unknown): string {
  if (
    typeof value !== 'string' ||
    !value ||
    value !== value.trim() ||
    value.length > 200 ||
    [...value].some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127)
  )
    throw new Error('Screen-only native identity is invalid.');
  return value;
}
function fingerprint(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}
function intent(prepared: PreparedOpportunityScreening) {
  return {
    contract: OPPORTUNITY_SCREENING_ONLY_JOB_CONTRACT,
    stage: 'screening_only',
    screeningVersion: OPPORTUNITY_SCREENING_VERSION,
    sourceContentFingerprint: prepared.sourceIdentity.sourceContentFingerprint,
    sourceContentVersion: prepared.sourceIdentity.sourceContentVersion,
    sourceFingerprint: prepared.sourceFingerprint,
    profileFingerprint: prepared.profileFingerprint,
    inputFingerprint: prepared.inputFingerprint,
  };
}
function sameIntent(
  value: unknown,
  prepared: PreparedOpportunityScreening,
): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const current = intent(prepared);
  const supplied = value as Args;
  return (
    Object.keys(supplied).length === Object.keys(current).length &&
    Object.entries(current).every(
      ([key, expected]) => supplied[key] === expected,
    )
  );
}
function sameSubject(
  left: RuntimeWorkspaceSubject,
  right: RuntimeWorkspaceSubject,
) {
  return (
    left.profileId === right.profileId &&
    left.tenantId === right.tenantId &&
    left.userId === right.userId
  );
}

type NativeScreeningJob = Pick<
  SmrtJob,
  | 'id'
  | 'status'
  | 'attempts'
  | 'tenantId'
  | 'objectId'
  | 'objectType'
  | 'queue'
  | 'method'
  | 'maxAttempts'
  | 'args'
>;
export interface OpportunityScreeningOnlyDependencies {
  getJob?: (id: string) => Promise<NativeScreeningJob | null>;
  runFresh?: typeof runAsRevalidatedJobWorkspaceSubject;
  withLock?: typeof withOpportunityLifecycleLock;
  prepare?: typeof prepareCurrentOpportunityAssessmentScreen;
  read?: typeof readCurrentOpportunityAssessmentScreen;
  assertNotAttempted?: typeof assertOpportunityAssessmentScreenNotAttempted;
  evaluate?: typeof evaluateOpportunityAssessmentScreen;
  startRun?: typeof startOpportunityIntelligenceAgentRun;
  finishRun?: typeof finishOpportunityIntelligenceAgentRun;
}

export type OpportunityScreeningOnlyResult = {
  stage: 'screening_only';
  status: 'screened' | 'screening_hold';
  current: ReturnType<typeof intent>;
  holdReasons: string[];
  receipt?: CurrentOpportunityAssessmentScreen;
  reused?: boolean;
};

/** Server captures current material and the active private tuple on the existing queue. */
export async function enqueueOpportunityScreeningOnly(
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
          await run.assertOperation('opportunities', 'read');
          const prepared = await prepareCurrentOpportunityAssessmentScreen(
            opportunityId,
            current,
          );
          return await (
            await SmrtJobCollection.create(getSmrtOptions())
          ).enqueueJob({
            objectId: opportunityId,
            objectType: nativeObject,
            method: nativeMethod,
            queue: OPPORTUNITY_SCREENING_ONLY_QUEUE,
            tenantId: current.tenantId,
            maxAttempts: 1,
            timeout: 3 * 60 * 1000,
            priority: 80,
            args: { ...args, screeningOnly: intent(prepared) },
          });
        },
      ),
  );
}

/** Screening terminates here. Provider calls and native run accounting are its only writes. */
export async function runOpportunityScreeningOnlyJob(
  opportunityId: string,
  args: Args,
  context: JobExecutionContext,
  subject: RuntimeWorkspaceSubject,
  dependencies: OpportunityScreeningOnlyDependencies = {},
): Promise<OpportunityScreeningOnlyResult> {
  identity(opportunityId);
  const runner = requireActiveRunnerExecutionContext(context);
  if (
    runner.job.queue !== OPPORTUNITY_SCREENING_ONLY_QUEUE ||
    runner.job.objectType !== nativeObject ||
    runner.job.method !== nativeMethod ||
    runner.job.tenantId !== subject.tenantId
  )
    throw new Error('Screen-only requires its authentic native job context.');
  const getJob =
    dependencies.getJob ??
    (async (id: string) =>
      await (await SmrtJobCollection.create(getSmrtOptions())).get(
        { id },
        { cache: false },
      ));
  const prepare =
    dependencies.prepare ?? prepareCurrentOpportunityAssessmentScreen;
  const read = dependencies.read ?? readCurrentOpportunityAssessmentScreen;
  const fresh = async <T>(work: () => Promise<T>): Promise<T> =>
    await (dependencies.runFresh ?? runAsRevalidatedJobWorkspaceSubject)(
      subject,
      'assessment.execute',
      async (current, run) => {
        if (!sameSubject(current, subject))
          throw new Error('Screen-only principal changed.');
        await run.assertOperation('opportunities', 'read');
        return await work();
      },
    );
  return await (dependencies.withLock ?? withOpportunityLifecycleLock)(
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
            job.tenantId !== subject.tenantId ||
            job.objectId !== opportunityId ||
            job.objectType !== nativeObject ||
            job.queue !== OPPORTUNITY_SCREENING_ONLY_QUEUE ||
            job.method !== nativeMethod ||
            job.maxAttempts !== 1 ||
            !sameSubject(
              runtimeWorkspaceSubjectFromJobArgs(job.args),
              subject,
            ) ||
            !sameSubject(runtimeWorkspaceSubjectFromJobArgs(args), subject)
          )
            throw new Error('Screen-only durable job or owner is not current.');
          const prepared = await prepare(opportunityId, subject);
          if (
            !sameIntent(job.args.screeningOnly, prepared) ||
            !sameIntent(args.screeningOnly, prepared) ||
            job.args.sourceCoverageStage !== undefined ||
            args.sourceCoverageStage !== undefined ||
            job.args.sourceCoverageRepair !== undefined ||
            args.sourceCoverageRepair !== undefined ||
            job.args.assessmentCoverageContract !== undefined ||
            args.assessmentCoverageContract !== undefined
          )
            throw new Error(
              'Screen-only durable material or intent is not current.',
            );
          return prepared;
        });
      const providerRunFresh: typeof runAsRevalidatedJobWorkspaceSubject =
        async <T>(
          candidate: RuntimeWorkspaceSubject,
          capability: Parameters<typeof runAsRevalidatedJobWorkspaceSubject>[1],
          work: (
            current: RuntimeWorkspaceSubject,
            run: PrincipalRun,
          ) => Promise<T>,
          freshDependencies?: Parameters<
            typeof runAsRevalidatedJobWorkspaceSubject
          >[3],
        ): Promise<T> => {
          if (
            !sameSubject(candidate, subject) ||
            capability !== 'assessment.execute'
          )
            throw new Error('Screen-only provider principal is not current.');
          return await (
            dependencies.runFresh ?? runAsRevalidatedJobWorkspaceSubject
          )(
            candidate,
            capability,
            async (current, run) => {
              await assertCurrent();
              return await work(current, run);
            },
            freshDependencies,
          );
        };
      const prepared = await assertCurrent();
      if (!prepared.profile.targetRoles.length) {
        await assertCurrent();
        return {
          stage: 'screening_only',
          status: 'screening_hold',
          current: intent(prepared),
          holdReasons: ['target_roles_missing'],
        };
      }
      const requireReceipt = async (
        receipt: CurrentOpportunityAssessmentScreen,
      ) => {
        const current = await assertCurrent();
        const actual = await read({
          opportunityId,
          subject,
          requestId: identity(receipt.requestId),
        });
        if (
          !actual ||
          actual.agentRunId !== receipt.agentRunId ||
          actual.inputFingerprint !== receipt.inputFingerprint ||
          actual.screen.inputFingerprint !== current.inputFingerprint ||
          actual.screen.profileFingerprint !== current.profileFingerprint ||
          actual.screen.sourceFingerprint !== current.sourceFingerprint ||
          fingerprint(actual) !== fingerprint(receipt)
        )
          throw new Error(
            'Screen-only completion lacks its current cited actual PRIVATE receipt.',
          );
        return actual;
      };
      const result = (
        receipt: CurrentOpportunityAssessmentScreen,
        reused: boolean,
      ): OpportunityScreeningOnlyResult => ({
        stage: 'screening_only',
        status: receipt.screen.holdReasons.length
          ? 'screening_hold'
          : 'screened',
        current: intent(prepared),
        holdReasons: receipt.screen.holdReasons,
        receipt,
        reused,
      });
      const cached = await read({ opportunityId, subject });
      if (cached) return result(await requireReceipt(cached), true);
      await (
        dependencies.assertNotAttempted ??
        assertOpportunityAssessmentScreenNotAttempted
      )(prepared, { opportunityId, workspaceSubject: subject });
      await assertCurrent();
      const agentRunId = await (
        dependencies.startRun ?? startOpportunityIntelligenceAgentRun
      )({ opportunityId, workspaceSubject: subject });
      try {
        await assertCurrent();
        const evaluated = await (
          dependencies.evaluate ?? evaluateOpportunityAssessmentScreen
        )(
          prepared,
          {
            agentRunId,
            opportunityId,
            contentFingerprint:
              prepared.sourceIdentity.sourceContentFingerprint,
            workspaceSubject: subject,
          },
          { runFresh: providerRunFresh },
        );
        const actual = await requireReceipt(evaluated);
        if (actual.agentRunId !== agentRunId)
          throw new Error('Screen-only original run changed.');
        await (dependencies.finishRun ?? finishOpportunityIntelligenceAgentRun)(
          agentRunId,
          'succeeded',
          '',
          subject,
        );
        return result(await requireReceipt(actual), false);
      } catch (error) {
        await (dependencies.finishRun ?? finishOpportunityIntelligenceAgentRun)(
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
