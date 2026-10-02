import { randomUUID } from 'node:crypto';
import { resolveDatabase, type SmrtObject } from '@happyvertical/smrt-core';
import {
  type JobExecutionContext,
  type SmrtJob,
  SmrtJobCollection,
  type SmrtJobData,
} from '@happyvertical/smrt-jobs';
import { getAppConfig } from './app-config.js';
import { bumpOpportunityChangeFeed } from './change-feed.js';
import { getDbConfig, getSmrtOptions } from './db.js';
import {
  type RuntimeWorkspaceSubject,
  runtimeWorkspaceSubjectFromJobArgs,
  withRuntimeWorkspaceSubject,
} from './job-workspace-subject.js';
import {
  enqueueOpportunityAssessmentCoverage,
  OpportunityAssessmentDependencyEnqueueError,
  type OpportunityAssessmentSourceDependency,
  type OpportunityAssessmentSourceStatus,
} from './opportunity-assessment-dependency-job.js';
import {
  opportunityAssessmentSubjectMaterialFingerprint,
  verifiedOpportunityRequirementCoverage,
} from './opportunity-assessment-input.js';
import {
  type OpportunityIntelligenceMode,
  type OpportunityIntelligenceOptions,
  processOpportunityIntelligence,
} from './opportunity-intelligence.js';
import {
  finishOpportunityIntelligenceAgentRun,
  type OpportunityIntelligenceGovernanceStore,
  startOpportunityIntelligenceAgentRun,
} from './opportunity-intelligence-governance.js';
import {
  ensureOpportunityIntelligenceJobDedupe,
  OPPORTUNITY_INTELLIGENCE_JOB_OBJECT_TYPE,
  OPPORTUNITY_INTELLIGENCE_METHOD,
  OPPORTUNITY_INTELLIGENCE_QUEUE,
  OPPORTUNITY_INTELLIGENCE_TIMEOUT_MS,
} from './opportunity-intelligence-job-schema.js';
import { requirementCoverageContextForOpportunity } from './opportunity-requirement-coverage.js';
import {
  hasRecordedRequirementCoverageAudit,
  readPartialOpportunityRequirementEvidence,
  requirementCoverageSourceDependencyFingerprint,
} from './opportunity-requirement-coverage-provider.js';
import { OPPORTUNITY_SOURCE_CONTENT_FINGERPRINT_VERSION } from './opportunity-source-content.js';
import { loadWorkspaceCandidateEvidence } from './resume-data.js';
import { getCollection } from './smrt.js';
import { getCurrentWorkspaceSubject } from './workspace-subject.js';

export {
  ensureOpportunityIntelligenceJobDedupe,
  OPPORTUNITY_INTELLIGENCE_JOB_OBJECT_TYPE,
  OPPORTUNITY_INTELLIGENCE_METHOD,
  OPPORTUNITY_INTELLIGENCE_QUEUE,
  OPPORTUNITY_INTELLIGENCE_TIMEOUT_MS,
} from './opportunity-intelligence-job-schema.js';

export interface OpportunityIntelligenceJobArgs
  extends Record<string, unknown> {
  applicationId?: string;
  contentFingerprint?: string;
  contentFingerprintVersion?: string;
  contentVersion?: number;
  scoringMaterialFingerprint?: string;
  modes?: OpportunityIntelligenceMode | OpportunityIntelligenceMode[];
  reason?: string;
  sourceCrawlId?: string;
  sourceCrawlItemId?: string;
  sourceId?: string;
  /** Server-derived from a current actual GLOBAL evidence receipt. */
  partialAssessmentEvidence?: boolean;
}

export interface OpportunityIntelligenceEnqueueResult {
  enqueued: boolean;
  job: SmrtJob;
  sourceDependency?: OpportunityAssessmentSourceDependency;
  stage?: 'source_preparation' | 'private_assessment';
  sourceStatus?: OpportunityAssessmentSourceStatus;
}

interface OpportunityIntelligenceJobCollection {
  create: (data: SmrtJobData) => Promise<SmrtJob>;
  enqueueJob?: (data: SmrtJobData) => Promise<SmrtJob>;
  list: (options?: {
    limit?: number;
    orderBy?: string | string[];
    where?: Record<string, unknown>;
  }) => Promise<SmrtJob[]>;
}

export interface EnqueueOpportunityIntelligenceOptions {
  collection?: OpportunityIntelligenceJobCollection;
  now?: Date;
  opportunityCollection?: {
    get: (
      id: { id: string },
      options: { cache: false },
    ) => Promise<unknown | null | undefined>;
  };
  reason?: string;
}

export interface RunOpportunityIntelligenceJobDependencies {
  readCurrentOpportunity?: (id: string) => Promise<OpportunityJobTarget>;
  /** Freshly verified by the runtime job wrapper; never read from payload. */
  workspaceSubject?: RuntimeWorkspaceSubject;
  finishRun?: typeof finishOpportunityIntelligenceAgentRun;
  governanceStore?: OpportunityIntelligenceGovernanceStore;
  processor?: (options: OpportunityIntelligenceOptions) => Promise<{
    failed?: number;
    message: string;
    stale?: boolean;
    status: string;
  }>;
  startRun?: typeof startOpportunityIntelligenceAgentRun;
  updateStatus?: (
    opportunityId: string,
    contentFingerprint: string,
    status: 'completed' | 'failed' | 'skipped',
  ) => Promise<void>;
}

export type OpportunityIntelligenceEnqueueErrorCode =
  | 'opportunity_id_required'
  | 'opportunity_not_found';

export class OpportunityIntelligenceEnqueueError extends Error {
  code: OpportunityIntelligenceEnqueueErrorCode;

  constructor(code: OpportunityIntelligenceEnqueueErrorCode, message: string) {
    super(message);
    this.name = 'OpportunityIntelligenceEnqueueError';
    this.code = code;
  }
}

interface OpportunityJobTarget {
  id?: unknown;
  sourceContentFingerprint?: unknown;
  sourceContentVersion?: unknown;
  sourceId?: unknown;
  toJSON?: () => Record<string, unknown>;
}

/** Native objects expose their public source fields through SMRT serialization. */
function opportunitySourceRecord(
  opportunity: OpportunityJobTarget,
): Record<string, unknown> {
  return typeof opportunity.toJSON === 'function'
    ? opportunity.toJSON()
    : Object.fromEntries(Object.entries(opportunity));
}

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function positiveInteger(value: unknown): number {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.trunc(number) : 0;
}

function requireMatchingActiveWorkspaceJob(
  job: SmrtJob,
  subject: RuntimeWorkspaceSubject,
): void {
  try {
    const stored = runtimeWorkspaceSubjectFromJobArgs(job.args);
    if (
      job.tenantId !== subject.tenantId ||
      stored.tenantId !== subject.tenantId ||
      stored.userId !== subject.userId ||
      stored.profileId !== subject.profileId
    ) {
      throw new Error('mismatch');
    }
  } catch {
    // Do not disclose an active job belonging to a different workspace.
    throw new OpportunityIntelligenceEnqueueError(
      'opportunity_not_found',
      'Opportunity not found.',
    );
  }
}

export async function updateOpportunityIntelligenceTerminalStatus(
  opportunityId: string,
  contentFingerprint: string,
  status: 'completed' | 'failed' | 'skipped',
): Promise<void> {
  const db = await resolveDatabase(getDbConfig());
  const result = await db.query(
    `
      UPDATE opportunities
      SET source_intelligence_status = ?, updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
        AND (? = '' OR source_content_fingerprint = ?)
    `,
    [status, opportunityId, contentFingerprint, contentFingerprint],
  );
  // Issue #436: a raw statement bypasses SMRT's change feed, so a mounted
  // admin list would keep showing the previous intelligence status.
  if ((result?.rowCount ?? 0) > 0) {
    await bumpOpportunityChangeFeed(db, [opportunityId]);
  }
}

async function requireOpportunity(
  opportunityId: string,
  options: Pick<EnqueueOpportunityIntelligenceOptions, 'opportunityCollection'>,
): Promise<OpportunityJobTarget> {
  const opportunityCollection =
    options.opportunityCollection ?? (await getCollection('Opportunity'));
  const opportunity = await opportunityCollection.get(
    { id: opportunityId },
    { cache: false },
  );
  if (!opportunity) {
    throw new OpportunityIntelligenceEnqueueError(
      'opportunity_not_found',
      'Opportunity not found.',
    );
  }
  return opportunity as OpportunityJobTarget;
}

export function isOpportunityIntelligenceEnqueueError(
  error: unknown,
): error is
  | OpportunityIntelligenceEnqueueError
  | OpportunityAssessmentDependencyEnqueueError {
  return (
    error instanceof OpportunityIntelligenceEnqueueError ||
    error instanceof OpportunityAssessmentDependencyEnqueueError
  );
}

async function findActiveOpportunityIntelligenceJobInCollection(
  collection: OpportunityIntelligenceJobCollection,
  opportunityId: string,
  contentFingerprint = '',
  scoringMaterialFingerprint = '',
): Promise<SmrtJob | null> {
  const jobs = await collection.list({
    ...(contentFingerprint ? {} : { limit: 1 }),
    orderBy: ['priority DESC', 'run_at ASC'],
    where: {
      method: OPPORTUNITY_INTELLIGENCE_METHOD,
      objectId: opportunityId,
      objectType: OPPORTUNITY_INTELLIGENCE_JOB_OBJECT_TYPE,
      queue: OPPORTUNITY_INTELLIGENCE_QUEUE,
      status: ['pending', 'running'],
    },
  });
  if (!contentFingerprint && !scoringMaterialFingerprint)
    return jobs[0] ?? null;
  return (
    jobs.find(
      (job) =>
        stringValue(job.args?.contentFingerprint) === contentFingerprint &&
        stringValue(job.args?.scoringMaterialFingerprint) ===
          scoringMaterialFingerprint,
    ) ?? null
  );
}

export async function findActiveOpportunityIntelligenceJob(
  opportunityId: string,
  contentFingerprint = '',
  options: Pick<EnqueueOpportunityIntelligenceOptions, 'collection'> = {},
  scoringMaterialFingerprint = '',
): Promise<SmrtJob | null> {
  const collection = (options.collection ??
    (await SmrtJobCollection.create({
      ...getSmrtOptions(),
    }))) as OpportunityIntelligenceJobCollection;
  return await findActiveOpportunityIntelligenceJobInCollection(
    collection,
    opportunityId.trim(),
    contentFingerprint.trim(),
    scoringMaterialFingerprint.trim(),
  );
}

export async function enqueueOpportunityIntelligenceWithStatus(
  opportunityId: string,
  args: OpportunityIntelligenceJobArgs = {},
  options: EnqueueOpportunityIntelligenceOptions = {},
): Promise<OpportunityIntelligenceEnqueueResult> {
  // Existing source/reconciliation workers have no workspace subject and keep
  // their explicit global/operator path. A request-bound caller is always
  // captured as its current verified subject, never from `args` or options.
  if (getCurrentWorkspaceSubject()) {
    return await enqueueWorkspaceOpportunityIntelligenceWithStatus(
      opportunityId,
      args,
      options,
    );
  }
  if (getAppConfig().workspaceMode === 'shared') {
    throw new OpportunityIntelligenceEnqueueError(
      'opportunity_not_found',
      'Shared workspace intelligence jobs require a bound workspace subject.',
    );
  }
  return await enqueueOpportunityIntelligenceInternal(
    opportunityId,
    args,
    options,
  );
}

/** Queue a candidate-owned intelligence run from the current verified subject. */
export async function enqueueWorkspaceOpportunityIntelligenceWithStatus(
  opportunityId: string,
  args: OpportunityIntelligenceJobArgs = {},
  options: EnqueueOpportunityIntelligenceOptions = {},
): Promise<OpportunityIntelligenceEnqueueResult> {
  const {
    partialAssessmentEvidence: _ignoredPartial,
    skipScreening: _ignoredSkipScreening,
    screeningOutcome: _ignoredScreeningOutcome,
    screeningEvidence: _ignoredScreeningEvidence,
    screeningInputFingerprint: _ignoredScreeningFingerprint,
    candidatePreferences: _ignoredCandidatePreferences,
    ...candidateArgs
  } = args;
  const envelopedArgs = withRuntimeWorkspaceSubject(candidateArgs);
  const subject = runtimeWorkspaceSubjectFromJobArgs(envelopedArgs);
  const requestedModes = Array.isArray(args.modes) ? args.modes : [args.modes];
  if (requestedModes.length === 1 && requestedModes[0] === 'extract') {
    // Explicit source-only/operator work is not an assessment intent. The
    // native wrapper retains its shared-mode restriction for this path.
    return await enqueueOpportunityIntelligenceInternal(
      opportunityId,
      envelopedArgs,
      options,
      subject,
    );
  }
  const opportunity = await requireOpportunity(opportunityId.trim(), options);
  const sourceRecord = opportunitySourceRecord(opportunity);
  const coverage = verifiedOpportunityRequirementCoverage(sourceRecord);
  const fullReady = Boolean(
    coverage &&
      (await hasRecordedRequirementCoverageAudit(
        opportunityId.trim(),
        requirementCoverageContextForOpportunity(sourceRecord),
        coverage.ledger,
      )),
  );
  const partial = fullReady
    ? undefined
    : await readPartialOpportunityRequirementEvidence(sourceRecord);
  if (!fullReady && !partial?.acceptedRequirements.length) {
    const enqueueJob = options.collection?.enqueueJob;
    if (options.collection && !enqueueJob) {
      throw new Error(
        'Source preparation requires native job enqueue capability.',
      );
    }
    return await enqueueOpportunityAssessmentCoverage(
      opportunityId,
      candidateArgs,
      {
        ...options,
        ...(options.collection && enqueueJob
          ? {
              collection: {
                enqueueJob: enqueueJob.bind(options.collection),
                list: options.collection.list.bind(options.collection),
              },
            }
          : { collection: undefined }),
      },
    );
  }
  // Candidate evidence is loaded only after the recorded global prerequisite
  // is current; source preparation jobs never capture this material.
  const evidence = await loadWorkspaceCandidateEvidence(subject);
  const requirementCoverageFingerprint = fullReady
    ? coverage!.fingerprint
    : partial!.fingerprint;
  const subjectMaterialFingerprint =
    opportunityAssessmentSubjectMaterialFingerprint({
      candidateMaterialFingerprint: evidence.fingerprint,
      sourceContentFingerprint: stringValue(
        opportunity.sourceContentFingerprint,
      ),
      sourceContentVersion: positiveInteger(opportunity.sourceContentVersion),
      ...(requirementCoverageFingerprint
        ? { requirementCoverageFingerprint }
        : {}),
      subject,
    });
  const result = await enqueueOpportunityIntelligenceInternal(
    opportunityId,
    {
      ...envelopedArgs,
      modes:
        envelopedArgs.modes ?? ('assessment' as OpportunityIntelligenceMode),
      scoringMaterialFingerprint: subjectMaterialFingerprint,
      partialAssessmentEvidence: !fullReady,
    },
    options,
    subject,
  );
  return {
    ...result,
    stage: 'private_assessment',
    ...(!fullReady ? { sourceStatus: 'partial' as const } : {}),
  };
}

async function enqueueOpportunityIntelligenceInternal(
  opportunityId: string,
  args: OpportunityIntelligenceJobArgs,
  options: EnqueueOpportunityIntelligenceOptions,
  runtimeWorkspaceSubject?: RuntimeWorkspaceSubject,
): Promise<OpportunityIntelligenceEnqueueResult> {
  const normalizedOpportunityId = opportunityId.trim();
  if (!normalizedOpportunityId) {
    throw new OpportunityIntelligenceEnqueueError(
      'opportunity_id_required',
      'Opportunity id is required.',
    );
  }
  const opportunity = await requireOpportunity(
    normalizedOpportunityId,
    options,
  );
  const currentFingerprint = stringValue(opportunity.sourceContentFingerprint);
  const currentVersion = positiveInteger(opportunity.sourceContentVersion);
  const requestedFingerprint = stringValue(args.contentFingerprint);
  const requestedVersion = positiveInteger(args.contentVersion);
  const modes = Array.isArray(args.modes) ? args.modes : [args.modes];
  const sourceOnlyExtraction = modes.length === 1 && modes[0] === 'extract';
  const resolvedArgs: OpportunityIntelligenceJobArgs = {
    ...args,
    ...(sourceOnlyExtraction
      ? {
          scoringMaterialFingerprint:
            requirementCoverageSourceDependencyFingerprint(
              opportunitySourceRecord(opportunity),
            ),
        }
      : {}),
    ...(currentFingerprint || requestedFingerprint
      ? {
          contentFingerprint: currentFingerprint || requestedFingerprint,
          contentFingerprintVersion:
            OPPORTUNITY_SOURCE_CONTENT_FINGERPRINT_VERSION,
        }
      : {}),
    ...(currentVersion || requestedVersion
      ? { contentVersion: currentVersion || requestedVersion }
      : {}),
    ...(stringValue(opportunity.sourceId) || stringValue(args.sourceId)
      ? {
          sourceId:
            stringValue(opportunity.sourceId) || stringValue(args.sourceId),
        }
      : {}),
  };

  const collection = (options.collection ??
    (await SmrtJobCollection.create({
      ...getSmrtOptions(),
    }))) as OpportunityIntelligenceJobCollection;
  if (!options.collection) await ensureOpportunityIntelligenceJobDedupe();

  const existingJob = await findActiveOpportunityIntelligenceJobInCollection(
    collection,
    normalizedOpportunityId,
    stringValue(resolvedArgs.contentFingerprint),
    stringValue(resolvedArgs.scoringMaterialFingerprint),
  );
  if (existingJob) {
    if (runtimeWorkspaceSubject) {
      requireMatchingActiveWorkspaceJob(existingJob, runtimeWorkspaceSubject);
    }
    return { enqueued: false, job: existingJob };
  }

  try {
    const data: SmrtJobData = {
      args: {
        ...resolvedArgs,
        modes: resolvedArgs.modes ?? 'all',
        reason: options.reason ?? resolvedArgs.reason ?? 'manual',
        ...(runtimeWorkspaceSubject ? { runtimeWorkspaceSubject } : {}),
      },
      // One-shot avoids duplicate LLM spend/audit writes; admins can requeue
      // after inspecting the failed AgentRun diagnostics.
      maxAttempts: 1,
      method: OPPORTUNITY_INTELLIGENCE_METHOD,
      objectId: normalizedOpportunityId,
      objectType: OPPORTUNITY_INTELLIGENCE_JOB_OBJECT_TYPE,
      priority: 80,
      queue: OPPORTUNITY_INTELLIGENCE_QUEUE,
      runAt: options.now ?? new Date(),
      ...(runtimeWorkspaceSubject
        ? { tenantId: runtimeWorkspaceSubject.tenantId }
        : {}),
      timeout: OPPORTUNITY_INTELLIGENCE_TIMEOUT_MS,
    };

    // The native enqueue path enforces the tenant's in-flight limit. Only
    // explicitly injected legacy test collections use create/save.
    if (collection.enqueueJob) {
      const job = await collection.enqueueJob(data);
      return { enqueued: true, job };
    }
    if (!options.collection) {
      throw new Error('Native job enqueue capability is unavailable.');
    }
    const job = await collection.create(data);

    if (!('id' in job) || !job.id) {
      (job as SmrtObject).id = randomUUID();
    }

    await job.save();
    return { enqueued: true, job: job as SmrtJob };
  } catch (error) {
    // SMRT normalizes PostgreSQL uniqueness violations and may discard the
    // original index name. Re-read the exact dedupe key after any failed save;
    // if a concurrent writer won, that active job is the successful outcome.
    const activeJob = await findActiveOpportunityIntelligenceJobInCollection(
      collection,
      normalizedOpportunityId,
      stringValue(resolvedArgs.contentFingerprint),
      stringValue(resolvedArgs.scoringMaterialFingerprint),
    );
    if (activeJob) {
      if (runtimeWorkspaceSubject) {
        requireMatchingActiveWorkspaceJob(activeJob, runtimeWorkspaceSubject);
      }
      return { enqueued: false, job: activeJob };
    }
    throw error;
  }
}

export async function enqueueOpportunityIntelligence(
  opportunityId: string,
  args: OpportunityIntelligenceJobArgs = {},
  options: EnqueueOpportunityIntelligenceOptions = {},
): Promise<SmrtJob> {
  return (
    await enqueueOpportunityIntelligenceWithStatus(opportunityId, args, options)
  ).job;
}

export async function runOpportunityIntelligenceJob(
  opportunity: OpportunityJobTarget,
  args: OpportunityIntelligenceJobArgs = {},
  context?: JobExecutionContext,
  dependencies: RunOpportunityIntelligenceJobDependencies = {},
) {
  const opportunityId = stringValue(opportunity.id);
  if (!opportunityId) throw new Error('Opportunity id is required.');

  context?.logger?.info?.('Starting opportunity intelligence.', {
    contentFingerprint: args.contentFingerprint,
    contentVersion: args.contentVersion,
    modes: args.modes ?? 'all',
    opportunityId,
    reason: args.reason ?? 'manual',
    sourceCrawlId: args.sourceCrawlId,
    sourceCrawlItemId: args.sourceCrawlItemId,
    sourceId: args.sourceId,
  });

  const expectedFingerprint = stringValue(args.contentFingerprint);
  const currentFingerprint = stringValue(opportunity.sourceContentFingerprint);
  if (
    expectedFingerprint &&
    currentFingerprint &&
    expectedFingerprint !== currentFingerprint
  ) {
    context?.logger?.info?.('Skipped stale opportunity intelligence.', {
      contentFingerprint: expectedFingerprint,
      currentFingerprint,
      opportunityId,
    });
    return {
      failed: 0,
      message: 'Skipped stale opportunity intelligence content fingerprint.',
      status: 'skipped',
    };
  }

  const processor = dependencies.processor ?? processOpportunityIntelligence;
  let partialAssessmentEvidence = false;
  if (args.partialAssessmentEvidence) {
    const current = dependencies.workspaceSubject
      ? await (
          dependencies.readCurrentOpportunity ??
          (async (id: string) => await requireOpportunity(id, {}))
        )(opportunityId)
      : undefined;
    const partial = dependencies.workspaceSubject
      ? await readPartialOpportunityRequirementEvidence(
          opportunitySourceRecord(current!),
        )
      : undefined;
    if (
      !partial?.acceptedRequirements.length ||
      partial.context.sourceFingerprint !==
        stringValue(current?.sourceContentFingerprint) ||
      (expectedFingerprint &&
        partial.context.sourceFingerprint !== expectedFingerprint) ||
      partial.context.sourceVersion !==
        positiveInteger(current?.sourceContentVersion) ||
      (args.contentVersion !== undefined &&
        partial.context.sourceVersion !== args.contentVersion)
    )
      return {
        failed: 0,
        message:
          'Current recorded source evidence is required for private partial matching.',
        status: 'skipped',
      };
    partialAssessmentEvidence = true;
  }
  const signal = AbortSignal.timeout(OPPORTUNITY_INTELLIGENCE_TIMEOUT_MS);
  const shouldCreateRun =
    !dependencies.processor || Boolean(dependencies.startRun);
  const startRun =
    dependencies.startRun ?? startOpportunityIntelligenceAgentRun;
  const finishRun =
    dependencies.finishRun ?? finishOpportunityIntelligenceAgentRun;
  const updateStatus =
    dependencies.updateStatus ??
    (dependencies.processor || dependencies.workspaceSubject
      ? undefined
      : updateOpportunityIntelligenceTerminalStatus);
  const updateStatusBestEffort = async (
    status: 'completed' | 'failed' | 'skipped',
  ): Promise<void> => {
    if (!updateStatus) return;
    try {
      await updateStatus(opportunityId, expectedFingerprint, status);
    } catch (error) {
      context?.logger?.error?.(
        'Unable to persist opportunity intelligence terminal status.',
        {
          message: error instanceof Error ? error.message : String(error),
          opportunityId,
          status,
        },
      );
    }
  };
  const agentRunId = shouldCreateRun
    ? await startRun({
        opportunityId,
        sourceCrawlId: stringValue(args.sourceCrawlId),
        sourceId: stringValue(args.sourceId),
        userId: dependencies.workspaceSubject?.userId ?? '',
        workspaceSubject: dependencies.workspaceSubject,
      })
    : '';
  let result: Awaited<ReturnType<typeof processor>>;
  try {
    result = await processor({
      agentRunId,
      applicationId: stringValue(args.applicationId),
      expectedSourceContentFingerprint: expectedFingerprint,
      expectedScoringMaterialFingerprint: stringValue(
        args.scoringMaterialFingerprint,
      ),
      governanceStore: dependencies.governanceStore,
      modes: args.modes ?? 'all',
      partialAssessmentEvidence,
      opportunityId,
      signal,
      sourceContentVersion: args.contentVersion,
      sourceCrawlId: stringValue(args.sourceCrawlId),
      sourceCrawlItemId: stringValue(args.sourceCrawlItemId),
      sourceId: stringValue(args.sourceId),
      user: dependencies.workspaceSubject
        ? { id: dependencies.workspaceSubject.userId }
        : null,
      workspaceSubject: dependencies.workspaceSubject,
    });
  } catch (error) {
    if (agentRunId) {
      await finishRun(
        agentRunId,
        'failed',
        error instanceof Error ? error.message : String(error),
        dependencies.workspaceSubject,
      );
    }
    await updateStatusBestEffort('failed');
    throw error;
  }

  if (result.status === 'skipped') {
    if (agentRunId)
      await finishRun(
        agentRunId,
        'succeeded',
        '',
        dependencies.workspaceSubject,
      );
    if (!result.stale) await updateStatusBestEffort('skipped');
    context?.logger?.info?.(
      result.stale
        ? 'Skipped stale opportunity intelligence.'
        : 'Skipped opportunity intelligence.',
      {
        contentFingerprint: expectedFingerprint,
        message: result.message,
        opportunityId,
      },
    );
    return result;
  }

  if (result.status !== 'processed' || Number(result.failed ?? 0) > 0) {
    context?.logger?.error?.('Opportunity intelligence failed.', {
      failed: result.failed ?? 0,
      message: result.message,
      opportunityId,
    });
    if (agentRunId)
      await finishRun(
        agentRunId,
        'failed',
        result.message,
        dependencies.workspaceSubject,
      );
    await updateStatusBestEffort('failed');
    throw new Error(result.message);
  }

  context?.logger?.info?.('Opportunity intelligence completed.', {
    message: result.message,
    opportunityId,
  });
  if (agentRunId)
    await finishRun(agentRunId, 'succeeded', '', dependencies.workspaceSubject);
  await updateStatusBestEffort('completed');

  return result;
}
