import { randomUUID } from 'node:crypto';
import { resolveDatabase, type SmrtObject } from '@happyvertical/smrt-core';
import {
  type JobExecutionContext,
  type SmrtJob,
  SmrtJobCollection,
  type SmrtJobData,
} from '@happyvertical/smrt-jobs';
import { bumpOpportunityChangeFeed } from './change-feed.js';
import { getDbConfig, getSmrtOptions } from './db.js';
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
import { OPPORTUNITY_SOURCE_CONTENT_FINGERPRINT_VERSION } from './opportunity-source-content.js';
import { getCollection } from './smrt.js';

export {
  ensureOpportunityIntelligenceJobDedupe,
  OPPORTUNITY_INTELLIGENCE_JOB_OBJECT_TYPE,
  OPPORTUNITY_INTELLIGENCE_METHOD,
  OPPORTUNITY_INTELLIGENCE_QUEUE,
  OPPORTUNITY_INTELLIGENCE_TIMEOUT_MS,
} from './opportunity-intelligence-job-schema.js';

export interface OpportunityIntelligenceJobArgs {
  applicationId?: string;
  contentFingerprint?: string;
  contentFingerprintVersion?: string;
  contentVersion?: number;
  modes?: OpportunityIntelligenceMode | OpportunityIntelligenceMode[];
  reason?: string;
  sourceCrawlId?: string;
  sourceCrawlItemId?: string;
  sourceId?: string;
  userId?: string;
}

export interface OpportunityIntelligenceEnqueueResult {
  enqueued: boolean;
  job: SmrtJob;
}

interface OpportunityIntelligenceJobCollection {
  create: (data: SmrtJobData) => Promise<SmrtJob>;
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
    get: (id: string) => Promise<unknown | null | undefined>;
  };
  reason?: string;
  user?: { id?: unknown } | null;
}

export interface RunOpportunityIntelligenceJobDependencies {
  finishRun?: (
    agentRunId: string,
    status: 'failed' | 'succeeded',
    error?: string,
  ) => Promise<void>;
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
}

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function positiveInteger(value: unknown): number {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.trunc(number) : 0;
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
  const opportunity = await opportunityCollection.get(opportunityId);
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
): error is OpportunityIntelligenceEnqueueError {
  return error instanceof OpportunityIntelligenceEnqueueError;
}

async function findActiveOpportunityIntelligenceJobInCollection(
  collection: OpportunityIntelligenceJobCollection,
  opportunityId: string,
  contentFingerprint = '',
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
  if (!contentFingerprint) return jobs[0] ?? null;
  return (
    jobs.find(
      (job) => stringValue(job.args?.contentFingerprint) === contentFingerprint,
    ) ?? null
  );
}

export async function findActiveOpportunityIntelligenceJob(
  opportunityId: string,
  contentFingerprint = '',
  options: Pick<EnqueueOpportunityIntelligenceOptions, 'collection'> = {},
): Promise<SmrtJob | null> {
  const collection = (options.collection ??
    (await SmrtJobCollection.create({
      ...getSmrtOptions(),
    }))) as OpportunityIntelligenceJobCollection;
  return await findActiveOpportunityIntelligenceJobInCollection(
    collection,
    opportunityId.trim(),
    contentFingerprint.trim(),
  );
}

export async function enqueueOpportunityIntelligenceWithStatus(
  opportunityId: string,
  args: OpportunityIntelligenceJobArgs = {},
  options: EnqueueOpportunityIntelligenceOptions = {},
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
  const resolvedArgs: OpportunityIntelligenceJobArgs = {
    ...args,
    ...(requestedFingerprint || currentFingerprint
      ? {
          contentFingerprint: requestedFingerprint || currentFingerprint,
          contentFingerprintVersion:
            stringValue(args.contentFingerprintVersion) ||
            OPPORTUNITY_SOURCE_CONTENT_FINGERPRINT_VERSION,
        }
      : {}),
    ...(requestedVersion || currentVersion
      ? { contentVersion: requestedVersion || currentVersion }
      : {}),
    ...(stringValue(args.sourceId) || stringValue(opportunity.sourceId)
      ? {
          sourceId:
            stringValue(args.sourceId) || stringValue(opportunity.sourceId),
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
  );
  if (existingJob) return { enqueued: false, job: existingJob };

  try {
    const job = await collection.create({
      args: {
        ...resolvedArgs,
        modes: resolvedArgs.modes ?? 'all',
        reason: options.reason ?? resolvedArgs.reason ?? 'manual',
        userId:
          stringValue(options.user?.id) || stringValue(resolvedArgs.userId),
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
      timeout: OPPORTUNITY_INTELLIGENCE_TIMEOUT_MS,
    });

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
    );
    if (activeJob) return { enqueued: false, job: activeJob };
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
  const signal = AbortSignal.timeout(OPPORTUNITY_INTELLIGENCE_TIMEOUT_MS);
  const shouldCreateRun =
    !dependencies.processor || Boolean(dependencies.startRun);
  const startRun =
    dependencies.startRun ?? startOpportunityIntelligenceAgentRun;
  const finishRun =
    dependencies.finishRun ?? finishOpportunityIntelligenceAgentRun;
  const updateStatus =
    dependencies.updateStatus ??
    (dependencies.processor
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
        userId: stringValue(args.userId),
      })
    : '';
  let result: Awaited<ReturnType<typeof processor>>;
  try {
    result = await processor({
      agentRunId,
      applicationId: stringValue(args.applicationId),
      expectedSourceContentFingerprint: expectedFingerprint,
      governanceStore: dependencies.governanceStore,
      modes: args.modes ?? 'all',
      opportunityId,
      signal,
      sourceContentVersion: args.contentVersion,
      sourceCrawlId: stringValue(args.sourceCrawlId),
      sourceCrawlItemId: stringValue(args.sourceCrawlItemId),
      sourceId: stringValue(args.sourceId),
      user: stringValue(args.userId) ? { id: stringValue(args.userId) } : null,
    });
  } catch (error) {
    if (agentRunId) {
      await finishRun(
        agentRunId,
        'failed',
        error instanceof Error ? error.message : String(error),
      );
    }
    await updateStatusBestEffort('failed');
    throw error;
  }

  if (result.status === 'skipped') {
    if (agentRunId) await finishRun(agentRunId, 'succeeded');
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
    if (agentRunId) await finishRun(agentRunId, 'failed', result.message);
    await updateStatusBestEffort('failed');
    throw new Error(result.message);
  }

  context?.logger?.info?.('Opportunity intelligence completed.', {
    message: result.message,
    opportunityId,
  });
  if (agentRunId) await finishRun(agentRunId, 'succeeded');
  await updateStatusBestEffort('completed');

  return result;
}
