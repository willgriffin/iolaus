import { createHash } from 'node:crypto';
import type { PrincipalRun } from '@happyvertical/smrt-agents';
import {
  type JobExecutionContext,
  type SmrtJob,
  SmrtJobCollection,
  type SmrtJobData,
} from '@happyvertical/smrt-jobs';
import {
  runOpportunityLifecycleTransaction,
  withOpportunityLifecycleLock,
} from './application-workflow.js';
import { getSmrtOptions } from './db.js';
import {
  type RuntimeWorkspaceSubject,
  requireActiveRunnerExecutionContext,
  runAsRevalidatedJobWorkspaceSubject,
  runtimeWorkspaceSubjectFromJobArgs,
  withRuntimeWorkspaceSubject,
} from './job-workspace-subject.js';
import {
  defaultFencedOpportunityUpdate,
  processOpportunityWithLlm,
} from './opportunity-details.js';
import {
  finishOpportunityIntelligenceAgentRun,
  startOpportunityIntelligenceAgentRun,
} from './opportunity-intelligence-governance.js';
import {
  readRecordedRequirementCoverageOutcome,
  requirementCoverageSourceDependencyFingerprint,
} from './opportunity-requirement-coverage-provider.js';
import { getCollection } from './smrt.js';

/** A separate source-only prerequisite job on the existing intelligence queue. */
export const OPPORTUNITY_ASSESSMENT_DEPENDENCY_METHOD =
  'prepareAssessmentCoverage';
export const OPPORTUNITY_ASSESSMENT_DEPENDENCY_CONTRACT =
  'opportunity-assessment-dependency/v1';
export const OPPORTUNITY_ASSESSMENT_DEPENDENCY_TIMEOUT_MS = 3 * 60 * 1000;
export const OPPORTUNITY_ASSESSMENT_DEPENDENCY_QUEUE =
  'opportunity-intelligence';
export const OPPORTUNITY_ASSESSMENT_DEPENDENCY_OBJECT_TYPE =
  '@willgriffin/iolaus-site:Opportunity';

export interface OpportunityAssessmentDependencyJobArgs
  extends Record<string, unknown> {
  assessmentCoverageContract?: string;
  assessmentCoverageDedupeKey?: string;
  contentFingerprint?: string;
  contentVersion?: number;
  reason?: string;
  /** Server-written after a live AgentRun is created; callers cannot retain it. */
  sourcePreparationAgentRunId?: string;
  sourceDependencyFingerprint?: string;
}

export interface OpportunityAssessmentDependencyEnqueueResult {
  enqueued: boolean;
  job: SmrtJob;
  sourceDependency: OpportunityAssessmentSourceDependency;
  stage: 'source_preparation';
}

export interface OpportunityAssessmentSourceDependency {
  dedupeKey: string;
  kind: 'requirement_coverage';
  sourceContentFingerprint: string;
  sourceContentVersion: number;
}

export interface OpportunityAssessmentDependencyJobCollection {
  enqueueJob: (data: SmrtJobData) => Promise<SmrtJob>;
  list: (options?: {
    limit?: number;
    where?: Record<string, unknown>;
  }) => Promise<SmrtJob[]>;
}

export interface EnqueueOpportunityAssessmentDependencyOptions {
  collection?: OpportunityAssessmentDependencyJobCollection;
  now?: Date;
  opportunityCollection?: {
    get: (id: string) => Promise<unknown | null | undefined>;
  };
  reason?: string;
  withLifecycleLock?: <T>(
    opportunityId: string,
    action: () => Promise<T>,
  ) => Promise<T>;
}

type OpportunityRecord = Record<string, unknown> & { id?: unknown };

type SourcePreparationResult = {
  message: string;
  stale?: boolean;
  status: 'error' | 'processed' | 'skipped';
};

type FencedOpportunityUpdate = typeof defaultFencedOpportunityUpdate;

type SourceJobBridge = {
  sourcePreparationAgentRunId: string;
  sourceDependencyFingerprint: string;
};

export interface RunOpportunityAssessmentDependencyJobDependencies {
  enqueueAssessment?: (opportunityId: string) => Promise<unknown>;
  finishRun?: typeof finishOpportunityIntelligenceAgentRun;
  getOpportunity?: (opportunityId: string) => Promise<OpportunityRecord | null>;
  readCoverageOutcome?: typeof readRecordedRequirementCoverageOutcome;
  readPriorSourceJobBridge?: (
    context: JobExecutionContext,
    subject: RuntimeWorkspaceSubject,
    expected: {
      fingerprint: string;
      sourceDependencyFingerprint: string;
      version: number;
    },
    opportunityId: string,
  ) => Promise<SourceJobBridge | undefined>;
  recordSourcePreparationRun?: (
    context: JobExecutionContext,
    subject: RuntimeWorkspaceSubject,
    expected: {
      fingerprint: string;
      sourceDependencyFingerprint: string;
      version: number;
    },
    opportunityId: string,
    agentRunId: string,
  ) => Promise<void>;
  prepareSource?: (
    opportunityId: string,
    options: {
      agentRunId: string;
      expectedSourceContentFingerprint: string;
      fencedOpportunityUpdate: FencedOpportunityUpdate;
      signal: AbortSignal;
      sourceContentVersion: number;
    },
  ) => Promise<SourcePreparationResult>;
  runAsRevalidated?: <T>(
    subject: RuntimeWorkspaceSubject,
    capability: 'assessment.execute',
    work: (subject: RuntimeWorkspaceSubject, run: PrincipalRun) => Promise<T>,
  ) => Promise<T>;
  startRun?: typeof startOpportunityIntelligenceAgentRun;
  withLifecycleLock?: <T>(
    opportunityId: string,
    action: () => Promise<T>,
  ) => Promise<T>;
}

export class OpportunityAssessmentDependencyEnqueueError extends Error {
  constructor(
    readonly code:
      | 'opportunity_id_required'
      | 'opportunity_not_found'
      | 'source_coverage_blocked'
      | 'source_not_current',
    message: string,
  ) {
    super(message);
    this.name = 'OpportunityAssessmentDependencyEnqueueError';
  }
}

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function positiveInteger(value: unknown): number {
  const number = typeof value === 'number' ? Math.trunc(value) : 0;
  return Number.isSafeInteger(number) && number > 0 ? number : 0;
}

function sameSubject(
  left: RuntimeWorkspaceSubject,
  right: RuntimeWorkspaceSubject,
): boolean {
  return (
    left.tenantId === right.tenantId &&
    left.userId === right.userId &&
    left.profileId === right.profileId
  );
}

function sourceIdentity(opportunity: OpportunityRecord): {
  fingerprint: string;
  version: number;
} {
  return {
    fingerprint: text(opportunity.sourceContentFingerprint),
    version: positiveInteger(opportunity.sourceContentVersion),
  };
}

function sourceIdentityMatches(
  opportunity: OpportunityRecord | null,
  expected: { fingerprint: string; version: number },
): opportunity is OpportunityRecord {
  if (!opportunity) return false;
  const current = sourceIdentity(opportunity);
  return (
    current.fingerprint === expected.fingerprint &&
    current.version === expected.version
  );
}

/** Exact durable identity for one owner-bound source prerequisite. */
export function opportunityAssessmentCoverageDedupeKey(options: {
  sourceDependencyFingerprint: string;
  subject: RuntimeWorkspaceSubject;
}): string {
  const { subject } = options;
  return `assessment-coverage-job/v1:${createHash('sha256')
    .update(
      JSON.stringify({
        contract: OPPORTUNITY_ASSESSMENT_DEPENDENCY_CONTRACT,
        profileId: subject.profileId,
        sourceDependencyFingerprint: options.sourceDependencyFingerprint,
        tenantId: subject.tenantId,
        userId: subject.userId,
      }),
    )
    .digest('hex')}`;
}

export function opportunityAssessmentSourceDependency(options: {
  opportunityId: string;
  sourceContentFingerprint: string;
  sourceContentVersion: number;
  subject: RuntimeWorkspaceSubject;
}): OpportunityAssessmentSourceDependency {
  return {
    dedupeKey: `requirement-coverage/v1:${options.opportunityId}:${options.sourceContentFingerprint}:${options.sourceContentVersion}`,
    kind: 'requirement_coverage',
    sourceContentFingerprint: options.sourceContentFingerprint,
    sourceContentVersion: options.sourceContentVersion,
  };
}

function jobMatchesSourceDependency(
  job: SmrtJob,
  opportunityId: string,
  subject: RuntimeWorkspaceSubject,
  source: { fingerprint: string; version: number },
  sourceDependencyFingerprint: string,
): boolean {
  if (
    job.queue !== OPPORTUNITY_ASSESSMENT_DEPENDENCY_QUEUE ||
    job.objectType !== OPPORTUNITY_ASSESSMENT_DEPENDENCY_OBJECT_TYPE ||
    job.objectId !== opportunityId ||
    job.method !== OPPORTUNITY_ASSESSMENT_DEPENDENCY_METHOD ||
    job.tenantId !== subject.tenantId
  ) {
    return false;
  }
  const args = job.args;
  try {
    return (
      runtimeWorkspaceSubjectFromJobArgs(args).tenantId === subject.tenantId &&
      sameSubject(runtimeWorkspaceSubjectFromJobArgs(args), subject) &&
      args.assessmentCoverageContract ===
        OPPORTUNITY_ASSESSMENT_DEPENDENCY_CONTRACT &&
      args.assessmentCoverageDedupeKey ===
        opportunityAssessmentCoverageDedupeKey({
          sourceDependencyFingerprint,
          subject,
        }) &&
      args.contentFingerprint === source.fingerprint &&
      args.contentVersion === source.version &&
      args.sourceDependencyFingerprint === sourceDependencyFingerprint
    );
  } catch {
    return false;
  }
}

function activeJobMatches(
  job: SmrtJob,
  opportunityId: string,
  subject: RuntimeWorkspaceSubject,
  source: { fingerprint: string; version: number },
  sourceDependencyFingerprint: string,
): boolean {
  return (
    ['pending', 'running'].includes(job.status) &&
    jobMatchesSourceDependency(
      job,
      opportunityId,
      subject,
      source,
      sourceDependencyFingerprint,
    )
  );
}

function terminalSourceJobBridge(
  job: SmrtJob,
  opportunityId: string,
  currentSubject: RuntimeWorkspaceSubject,
  source: { fingerprint: string; version: number },
  sourceDependencyFingerprint: string,
): SourceJobBridge | undefined {
  if (
    !['completed', 'failed', 'cancelled'].includes(job.status) ||
    job.queue !== OPPORTUNITY_ASSESSMENT_DEPENDENCY_QUEUE ||
    job.objectType !== OPPORTUNITY_ASSESSMENT_DEPENDENCY_OBJECT_TYPE ||
    job.objectId !== opportunityId ||
    job.method !== OPPORTUNITY_ASSESSMENT_DEPENDENCY_METHOD ||
    job.tenantId !== currentSubject.tenantId
  ) {
    return undefined;
  }
  const args = job.args as OpportunityAssessmentDependencyJobArgs;
  let storedSubject: RuntimeWorkspaceSubject;
  try {
    storedSubject = runtimeWorkspaceSubjectFromJobArgs(args);
  } catch {
    return undefined;
  }
  if (
    storedSubject.tenantId !== currentSubject.tenantId ||
    args.assessmentCoverageContract !==
      OPPORTUNITY_ASSESSMENT_DEPENDENCY_CONTRACT ||
    args.assessmentCoverageDedupeKey !==
      opportunityAssessmentCoverageDedupeKey({
        sourceDependencyFingerprint,
        subject: storedSubject,
      }) ||
    args.contentFingerprint !== source.fingerprint ||
    args.contentVersion !== source.version ||
    args.sourceDependencyFingerprint !== sourceDependencyFingerprint
  ) {
    return undefined;
  }
  const sourcePreparationAgentRunId = text(args.sourcePreparationAgentRunId);
  return sourcePreparationAgentRunId
    ? { sourceDependencyFingerprint, sourcePreparationAgentRunId }
    : undefined;
}

function blockedCoverageMessage(reason: unknown): string {
  if (reason === 'confidence') {
    return 'Current source coverage is blocked by its recorded confidence audit.';
  }
  if (reason === 'attempt_failed') {
    return 'Current source coverage is blocked by its recorded provider attempt.';
  }
  return 'Current source coverage is blocked by its recorded structural audit.';
}

/** Reload the durable row; JobExecutionContext.job is metadata, never a job. */
async function loadCurrentSourceJob(
  context: JobExecutionContext,
): Promise<SmrtJob> {
  const runnerContext = requireActiveRunnerExecutionContext(context);
  const durableJobId = text(runnerContext.job.jobId);
  if (!durableJobId) {
    throw new Error('Source preparation job link cannot be persisted.');
  }
  const jobs = await SmrtJobCollection.create(getSmrtOptions());
  const job = await jobs.get(durableJobId);
  if (!job) throw new Error('Source preparation job link cannot be persisted.');
  return job;
}

/**
 * A retry can already have a server-created AgentRun link from its prior
 * attempt. Consult that exact currently-claimed row before overwriting it so a
 * paid failed receipt becomes a durable block instead of another provider call.
 */
async function readPriorSourceJobBridge(
  context: JobExecutionContext,
  subject: RuntimeWorkspaceSubject,
  expected: {
    fingerprint: string;
    sourceDependencyFingerprint: string;
    version: number;
  },
  opportunityId: string,
): Promise<SourceJobBridge | undefined> {
  const runnerContext = requireActiveRunnerExecutionContext(context);
  if (
    runnerContext.job.tenantId !== subject.tenantId ||
    runnerContext.job.queue !== OPPORTUNITY_ASSESSMENT_DEPENDENCY_QUEUE ||
    runnerContext.job.objectType !==
      OPPORTUNITY_ASSESSMENT_DEPENDENCY_OBJECT_TYPE ||
    runnerContext.job.method !== OPPORTUNITY_ASSESSMENT_DEPENDENCY_METHOD
  ) {
    throw new Error('Source preparation job bridge is not authentic.');
  }
  const job = await loadCurrentSourceJob(context);
  if (
    job.status !== 'running' ||
    job.attempts !== runnerContext.job.attempt ||
    !jobMatchesSourceDependency(
      job,
      opportunityId,
      subject,
      expected,
      expected.sourceDependencyFingerprint,
    )
  ) {
    throw new Error('Source preparation job bridge is not current.');
  }
  const sourcePreparationAgentRunId = text(
    (job.args as OpportunityAssessmentDependencyJobArgs)
      .sourcePreparationAgentRunId,
  );
  return sourcePreparationAgentRunId
    ? {
        sourceDependencyFingerprint: expected.sourceDependencyFingerprint,
        sourcePreparationAgentRunId,
      }
    : undefined;
}

async function defaultOpportunity(
  opportunityId: string,
): Promise<OpportunityRecord | null> {
  const collection = await getCollection('Opportunity');
  return (await collection.get(opportunityId)) as OpportunityRecord | null;
}

function requiredSourceArgs(args: OpportunityAssessmentDependencyJobArgs): {
  fingerprint: string;
  sourceDependencyFingerprint: string;
  version: number;
} {
  if (
    args.assessmentCoverageContract !==
    OPPORTUNITY_ASSESSMENT_DEPENDENCY_CONTRACT
  ) {
    throw new Error('Assessment coverage job contract is invalid.');
  }
  const fingerprint = text(args.contentFingerprint);
  const sourceDependencyFingerprint = text(args.sourceDependencyFingerprint);
  const version = positiveInteger(args.contentVersion);
  if (!fingerprint || !version || !sourceDependencyFingerprint) {
    throw new Error('Assessment coverage job source identity is invalid.');
  }
  return { fingerprint, sourceDependencyFingerprint, version };
}

/** Persist the source request's AgentRun link only on its authentic job row. */
async function recordSourcePreparationRun(
  context: JobExecutionContext,
  subject: RuntimeWorkspaceSubject,
  expected: {
    fingerprint: string;
    sourceDependencyFingerprint: string;
    version: number;
  },
  opportunityId: string,
  agentRunId: string,
): Promise<void> {
  const runnerContext = requireActiveRunnerExecutionContext(context);
  const durableJobId = text(runnerContext.job.jobId);
  if (
    !durableJobId ||
    runnerContext.job.tenantId !== subject.tenantId ||
    runnerContext.job.queue !== OPPORTUNITY_ASSESSMENT_DEPENDENCY_QUEUE ||
    runnerContext.job.objectType !==
      OPPORTUNITY_ASSESSMENT_DEPENDENCY_OBJECT_TYPE ||
    runnerContext.job.method !== OPPORTUNITY_ASSESSMENT_DEPENDENCY_METHOD
  ) {
    throw new Error('Source preparation job link cannot be persisted.');
  }
  // JobExecutionContext.job intentionally contains logging metadata only. Load
  // the durable row while the fresh tenant/principal context is active before
  // reading or changing its untrusted JSON arguments.
  const job = await loadCurrentSourceJob(context);
  const jobArgs = job.args as OpportunityAssessmentDependencyJobArgs;
  if (
    !agentRunId ||
    job.tenantId !== subject.tenantId ||
    job.status !== 'running' ||
    job.attempts !== runnerContext.job.attempt ||
    job.queue !== OPPORTUNITY_ASSESSMENT_DEPENDENCY_QUEUE ||
    job.objectType !== OPPORTUNITY_ASSESSMENT_DEPENDENCY_OBJECT_TYPE ||
    job.objectId !== opportunityId ||
    job.method !== OPPORTUNITY_ASSESSMENT_DEPENDENCY_METHOD ||
    !sameSubject(runtimeWorkspaceSubjectFromJobArgs(jobArgs), subject) ||
    jobArgs.assessmentCoverageContract !==
      OPPORTUNITY_ASSESSMENT_DEPENDENCY_CONTRACT ||
    jobArgs.contentFingerprint !== expected.fingerprint ||
    jobArgs.contentVersion !== expected.version ||
    jobArgs.sourceDependencyFingerprint !==
      expected.sourceDependencyFingerprint ||
    jobArgs.assessmentCoverageDedupeKey !==
      opportunityAssessmentCoverageDedupeKey({
        sourceDependencyFingerprint: expected.sourceDependencyFingerprint,
        subject,
      })
  ) {
    throw new Error('Source preparation job link cannot be persisted.');
  }
  job.args = { ...jobArgs, sourcePreparationAgentRunId: agentRunId };
  await job.save();
}

/**
 * Captures source identity from the current Opportunity and submits through the
 * native queue API. Caller-provided source values are always overwritten.
 */
export async function enqueueOpportunityAssessmentCoverage(
  opportunityId: string,
  args: OpportunityAssessmentDependencyJobArgs = {},
  options: EnqueueOpportunityAssessmentDependencyOptions = {},
): Promise<OpportunityAssessmentDependencyEnqueueResult> {
  const normalizedOpportunityId = text(opportunityId);
  if (!normalizedOpportunityId) {
    throw new OpportunityAssessmentDependencyEnqueueError(
      'opportunity_id_required',
      'Opportunity id is required.',
    );
  }
  const {
    sourcePreparationAgentRunId: _ignoredSourcePreparationAgentRunId,
    ...callerArgs
  } = args;
  const enveloped = withRuntimeWorkspaceSubject(callerArgs);
  const subject = runtimeWorkspaceSubjectFromJobArgs(enveloped);
  const getOpportunity = options.opportunityCollection
    ? async (id: string) =>
        (await options.opportunityCollection!.get(
          id,
        )) as OpportunityRecord | null
    : defaultOpportunity;
  const collection =
    options.collection ??
    ((await SmrtJobCollection.create(
      getSmrtOptions(),
    )) as unknown as OpportunityAssessmentDependencyJobCollection);
  const withLock = options.withLifecycleLock ?? withOpportunityLifecycleLock;
  return await withLock(normalizedOpportunityId, async () => {
    // This brief lock serializes active-job lookup with native enqueue. The
    // worker still has its own cache/provider fence before any paid request.
    const opportunity = await getOpportunity(normalizedOpportunityId);
    if (!opportunity || text(opportunity.id) !== normalizedOpportunityId) {
      throw new OpportunityAssessmentDependencyEnqueueError(
        'opportunity_not_found',
        'Opportunity not found.',
      );
    }
    const source = sourceIdentity(opportunity);
    if (!source.fingerprint || !source.version) {
      throw new OpportunityAssessmentDependencyEnqueueError(
        'source_not_current',
        'A current opportunity source is required for assessment preparation.',
      );
    }
    const sourceDependency = opportunityAssessmentSourceDependency({
      opportunityId: normalizedOpportunityId,
      sourceContentFingerprint: source.fingerprint,
      sourceContentVersion: source.version,
      subject,
    });
    const sourceDependencyFingerprint =
      requirementCoverageSourceDependencyFingerprint(opportunity);
    const candidates = await collection.list({
      limit: 100,
      where: {
        method: OPPORTUNITY_ASSESSMENT_DEPENDENCY_METHOD,
        objectId: normalizedOpportunityId,
        queue: OPPORTUNITY_ASSESSMENT_DEPENDENCY_QUEUE,
      },
    });
    // Prefer this profile's terminal row when present. A same-tenant row from
    // another profile is still a valid global source receipt fallback.
    const terminalCandidates = [
      ...candidates.filter(
        (job) =>
          ['completed', 'failed', 'cancelled'].includes(job.status) &&
          jobMatchesSourceDependency(
            job,
            normalizedOpportunityId,
            subject,
            source,
            sourceDependencyFingerprint,
          ),
      ),
      ...candidates,
    ];
    const terminalBridge = terminalCandidates
      .map((job) =>
        terminalSourceJobBridge(
          job,
          normalizedOpportunityId,
          subject,
          source,
          sourceDependencyFingerprint,
        ),
      )
      .find((bridge) => bridge !== undefined);
    const coverageOutcome = await readRecordedRequirementCoverageOutcome(
      normalizedOpportunityId,
      opportunity,
      terminalBridge,
    );
    if (coverageOutcome.status === 'blocked') {
      throw new OpportunityAssessmentDependencyEnqueueError(
        'source_coverage_blocked',
        blockedCoverageMessage(coverageOutcome.reason),
      );
    }
    // A terminal native refusal is an operational block for this exact private
    // intent, not evidence of billing or shared source quality. In particular,
    // do not reuse another profile's conservative/zero-usage failure here.
    if (
      coverageOutcome.status === 'missing' &&
      candidates.some(
        (job) =>
          job.status === 'failed' &&
          job.lastError ===
            'This idempotency key has a prior terminal failure and requires operator review.' &&
          jobMatchesSourceDependency(
            job,
            normalizedOpportunityId,
            subject,
            source,
            sourceDependencyFingerprint,
          ) &&
          terminalSourceJobBridge(
            job,
            normalizedOpportunityId,
            subject,
            source,
            sourceDependencyFingerprint,
          ) !== undefined,
      )
    ) {
      throw new OpportunityAssessmentDependencyEnqueueError(
        'source_coverage_blocked',
        'The current source preparation attempt requires operator review before assessment can resume.',
      );
    }
    const active = candidates.find((job) =>
      activeJobMatches(
        job,
        normalizedOpportunityId,
        subject,
        source,
        sourceDependencyFingerprint,
      ),
    );
    if (active) {
      return {
        enqueued: false,
        job: active,
        sourceDependency,
        stage: 'source_preparation' as const,
      };
    }
    const job = await collection.enqueueJob({
      args: {
        ...enveloped,
        assessmentCoverageContract: OPPORTUNITY_ASSESSMENT_DEPENDENCY_CONTRACT,
        assessmentCoverageDedupeKey: opportunityAssessmentCoverageDedupeKey({
          sourceDependencyFingerprint,
          subject,
        }),
        contentFingerprint: source.fingerprint,
        contentVersion: source.version,
        sourceDependencyFingerprint,
        reason:
          options.reason ??
          (text(enveloped.reason) || 'assessment_prerequisite'),
      },
      maxAttempts: 2,
      method: OPPORTUNITY_ASSESSMENT_DEPENDENCY_METHOD,
      objectId: normalizedOpportunityId,
      objectType: OPPORTUNITY_ASSESSMENT_DEPENDENCY_OBJECT_TYPE,
      priority: 80,
      queue: OPPORTUNITY_ASSESSMENT_DEPENDENCY_QUEUE,
      runAt: options.now ?? new Date(),
      tenantId: subject.tenantId,
      timeout: OPPORTUNITY_ASSESSMENT_DEPENDENCY_TIMEOUT_MS,
    });
    return {
      enqueued: true,
      job,
      sourceDependency,
      stage: 'source_preparation' as const,
    };
  });
}

/**
 * Runs only source preparation under the lifecycle lock. The subsequent
 * candidate continuation gets a new principal fence and re-reads the source
 * receipt, so no private payload is available to the provider phase.
 */
export async function runOpportunityAssessmentDependencyJob(
  opportunity: OpportunityRecord,
  args: OpportunityAssessmentDependencyJobArgs = {},
  context: JobExecutionContext,
  subject: RuntimeWorkspaceSubject,
  dependencies: RunOpportunityAssessmentDependencyJobDependencies = {},
): Promise<{
  message: string;
  status: 'prepared' | 'skipped';
}> {
  const opportunityId = text(opportunity.id);
  if (!opportunityId) throw new Error('Opportunity id is required.');
  const expected = requiredSourceArgs(args);
  const dedupeKey = opportunityAssessmentCoverageDedupeKey({
    sourceDependencyFingerprint: expected.sourceDependencyFingerprint,
    subject,
  });
  if (args.assessmentCoverageDedupeKey !== dedupeKey) {
    throw new Error('Assessment coverage job ownership identity is invalid.');
  }
  const getOpportunity = dependencies.getOpportunity ?? defaultOpportunity;
  const readCoverageOutcome =
    dependencies.readCoverageOutcome ?? readRecordedRequirementCoverageOutcome;
  const readPriorBridge =
    dependencies.readPriorSourceJobBridge ?? readPriorSourceJobBridge;
  const withLock =
    dependencies.withLifecycleLock ?? withOpportunityLifecycleLock;
  const startRun =
    dependencies.startRun ?? startOpportunityIntelligenceAgentRun;
  const finishRun =
    dependencies.finishRun ?? finishOpportunityIntelligenceAgentRun;
  const recordRun =
    dependencies.recordSourcePreparationRun ?? recordSourcePreparationRun;
  const runAsRevalidated =
    dependencies.runAsRevalidated ?? runAsRevalidatedJobWorkspaceSubject;
  const prepareSource =
    dependencies.prepareSource ??
    (async (id, options) =>
      await processOpportunityWithLlm(id, {
        agentRunId: options.agentRunId,
        expectedSourceContentFingerprint:
          options.expectedSourceContentFingerprint,
        fencedOpportunityUpdate: options.fencedOpportunityUpdate,
        signal: options.signal,
        sourceContentVersion: options.sourceContentVersion,
      }));

  const preparation = await withLock(
    opportunityId,
    async () =>
      await runAsRevalidated(
        subject,
        'assessment.execute',
        async (_subject, run) => {
          // Waiting for the advisory lock can outlive the method's initial native
          // context. Re-enter before even loading source or starting provider work.
          await run.assertOperation('opportunities', 'read');
          const current = await getOpportunity(opportunityId);
          if (
            !sourceIdentityMatches(current, expected) ||
            requirementCoverageSourceDependencyFingerprint(current) !==
              expected.sourceDependencyFingerprint
          ) {
            return {
              message: 'Skipped stale opportunity source.',
              ready: false as const,
            };
          }
          const initialCoverage = await readCoverageOutcome(
            opportunityId,
            current,
            await readPriorBridge(context, subject, expected, opportunityId),
          );
          if (initialCoverage.status === 'ready') {
            return {
              message: 'Reused verified source coverage.',
              ready: true as const,
            };
          }
          if (initialCoverage.status === 'blocked') {
            return {
              message: blockedCoverageMessage(initialCoverage.reason),
              ready: false as const,
            };
          }
          const agentRunId = await startRun({
            opportunityId,
            sourceId: text(current.sourceId),
            userId: subject.userId,
            workspaceSubject: subject,
          });
          // `recordRun` only resolves after the authentic, currently claimed native
          // job row has stored this server-created id. This bridge is then safe for
          // the outcome reader to correlate a paid/semantic source attempt.
          const sourceJob = {
            sourceDependencyFingerprint: expected.sourceDependencyFingerprint,
            sourcePreparationAgentRunId: agentRunId,
          };
          let result: SourcePreparationResult;
          try {
            await recordRun(
              context,
              subject,
              expected,
              opportunityId,
              agentRunId,
            );
            result = await prepareSource(opportunityId, {
              agentRunId,
              expectedSourceContentFingerprint: expected.fingerprint,
              fencedOpportunityUpdate: async (
                id,
                expectedSourceContentFingerprint,
                updates,
              ) =>
                await runAsRevalidated(
                  subject,
                  'assessment.execute',
                  async (_currentSubject, updateRun) => {
                    await updateRun.assertOperation('opportunities', 'read');
                    return await runOpportunityLifecycleTransaction(
                      async (database) =>
                        await defaultFencedOpportunityUpdate(
                          id,
                          expectedSourceContentFingerprint,
                          updates,
                          expected.version,
                          database,
                        ),
                    );
                  },
                ),
              signal: AbortSignal.timeout(
                OPPORTUNITY_ASSESSMENT_DEPENDENCY_TIMEOUT_MS,
              ),
              sourceContentVersion: expected.version,
            });
            await finishRun(
              agentRunId,
              result.status === 'processed' ? 'succeeded' : 'failed',
              result.status === 'processed' ? '' : result.message,
              subject,
            );
          } catch (error) {
            const message =
              error instanceof Error ? error.message : String(error);
            await finishRun(agentRunId, 'failed', message, subject);
            const currentAfterFailure = await getOpportunity(opportunityId);
            if (sourceIdentityMatches(currentAfterFailure, expected)) {
              const failedOutcome = await readCoverageOutcome(
                opportunityId,
                currentAfterFailure,
                sourceJob,
              );
              if (failedOutcome.status === 'blocked') {
                return {
                  message: blockedCoverageMessage(failedOutcome.reason),
                  ready: false as const,
                };
              }
            }
            throw error;
          }
          if (result.status !== 'processed') {
            if (result.status === 'error') throw new Error(result.message);
            return { message: result.message, ready: false as const };
          }
          const refreshed = await getOpportunity(opportunityId);
          if (
            !sourceIdentityMatches(refreshed, expected) ||
            requirementCoverageSourceDependencyFingerprint(refreshed) !==
              expected.sourceDependencyFingerprint
          ) {
            return {
              message: 'Skipped stale opportunity source.',
              ready: false as const,
            };
          }
          const refreshedCoverage = await readCoverageOutcome(
            opportunityId,
            refreshed,
            sourceJob,
          );
          if (refreshedCoverage.status === 'blocked') {
            return {
              message: blockedCoverageMessage(refreshedCoverage.reason),
              ready: false as const,
            };
          }
          if (refreshedCoverage.status !== 'ready') {
            throw new Error(
              'Source preparation completed without a recorded requirement coverage outcome.',
            );
          }
          return {
            message: 'Prepared verified source coverage.',
            ready: true as const,
          };
        },
      ),
  );

  if (!preparation.ready) {
    return { message: preparation.message, status: 'skipped' };
  }

  const enqueueAssessment =
    dependencies.enqueueAssessment ??
    (async (id: string) => {
      // The main intelligence queue now imports this prerequisite helper, so
      // keep the continuation edge dynamic instead of making a module cycle.
      const { enqueueWorkspaceOpportunityIntelligenceWithStatus } =
        await import('./opportunity-intelligence-job.js');
      return await enqueueWorkspaceOpportunityIntelligenceWithStatus(id, {
        modes: 'assessment',
      });
    });
  return await runAsRevalidated(
    subject,
    'assessment.execute',
    async (_currentSubject, run) => {
      await run.assertOperation('opportunities', 'read');
      const current = await getOpportunity(opportunityId);
      if (
        !sourceIdentityMatches(current, expected) ||
        requirementCoverageSourceDependencyFingerprint(current) !==
          expected.sourceDependencyFingerprint ||
        (
          await readCoverageOutcome(
            opportunityId,
            current,
            await readPriorBridge(context, subject, expected, opportunityId),
          )
        ).status !== 'ready'
      ) {
        return {
          message: 'Skipped stale opportunity source.',
          status: 'skipped' as const,
        };
      }
      await enqueueAssessment(opportunityId);
      return {
        message: 'Queued private opportunity assessment.',
        status: 'prepared' as const,
      };
    },
  );
}
