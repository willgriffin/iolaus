import { resolveDatabase } from '@happyvertical/smrt-core';
import type { JobExecutionContext } from '@happyvertical/smrt-jobs';
import { getDbConfig } from './db.js';
import type {
  CrawlOpportunitySourceSummary,
  CrawlOpportunitySourcesOptions,
  SourceLike,
} from './opportunity-source-crawler.js';
import {
  crawlOpportunitySource,
  SourceCrawlOwnershipError,
} from './opportunity-source-crawler.js';
import type { SourceCrawlWriteFence } from './source-crawl-operator.js';
import { assertOperableRootSource } from './source-provenance.js';
import {
  SOURCE_CRAWL_TIMEOUT_MS,
  type SourceCrawlJobArgs,
  type SyncSourceScheduleOptions,
  syncSourceSchedule,
} from './source-schedules.js';

interface CrawlableSourceRecord extends SourceLike {
  lastCheckedAt?: Date | null;
  nextCheckAt?: Date | string | null;
  refreshCadence?: unknown;
  save?: () => Promise<unknown>;
}

export interface RunSourceCrawlJobDependencies {
  writeFence?: SourceCrawlWriteFence;
  crawlSource?: (
    source: SourceLike,
    options?: CrawlOpportunitySourcesOptions,
  ) => Promise<CrawlOpportunitySourceSummary>;
  syncSchedule?: (
    source: CrawlableSourceRecord,
    options?: SyncSourceScheduleOptions,
  ) => Promise<unknown>;
  failRequestedCrawl?: (input: {
    error: Error;
    jobId: string;
    sourceCrawlId: string;
    sourceId: string;
  }) => Promise<boolean>;
}

function exactNonblankBinding(value: unknown): string {
  return typeof value === 'string' && value.length > 0 && value === value.trim()
    ? value
    : '';
}

async function failQueuedRequestedSourceCrawl(input: {
  error: Error;
  jobId: string;
  sourceCrawlId: string;
  sourceId: string;
}): Promise<boolean> {
  const database = await resolveDatabase(getDbConfig());
  const result = await database.query(
    `UPDATE source_crawls
     SET status = 'failed',
         finished_at = CURRENT_TIMESTAMP,
         error = ?,
         updated_at = CURRENT_TIMESTAMP
     WHERE id = ?
       AND source_id = ?
       AND status = 'queued'
       AND finished_at IS NULL
       AND job_id = ?
     RETURNING id`,
    [
      input.error.message.slice(0, 500),
      input.sourceCrawlId,
      input.sourceId,
      input.jobId,
    ],
  );
  return result.rows.length === 1;
}

export async function runSourceCrawlJob(
  source: CrawlableSourceRecord,
  args: SourceCrawlJobArgs = {},
  context?: JobExecutionContext,
  dependencies: RunSourceCrawlJobDependencies = {},
): Promise<CrawlOpportunitySourceSummary> {
  const crawlSource = dependencies.crawlSource ?? crawlOpportunitySource;
  const syncSchedule = dependencies.syncSchedule ?? syncSourceSchedule;
  const limit = Number(args.limit);
  const writeFence: SourceCrawlWriteFence =
    dependencies.writeFence ?? (async (work) => await work());

  assertOperableRootSource(source);

  const sourceCrawlId = exactNonblankBinding(args.sourceCrawlId);
  const jobId = exactNonblankBinding(context?.job.jobId);
  if (args.sourceCrawlId !== undefined && !sourceCrawlId) {
    throw new Error(
      'Source crawl refused without an exact durable crawl binding.',
    );
  }
  if (context?.job.jobId !== undefined && !jobId) {
    throw new Error(
      'Source crawl refused without an exact worker job binding.',
    );
  }

  if (source.isActive !== true) {
    const refusal = new Error(
      'Source crawl refused because the source is not explicitly active.',
    );
    if (sourceCrawlId) {
      if (!jobId) {
        throw new Error(
          'Source crawl refused without an exact worker job binding.',
        );
      }
      const terminalized = await writeFence(
        async () =>
          await (
            dependencies.failRequestedCrawl ?? failQueuedRequestedSourceCrawl
          )({
            error: refusal,
            jobId,
            sourceCrawlId,
            sourceId: String(source.id ?? ''),
          }),
      );
      if (!terminalized) {
        throw new Error(
          'Source crawl refusal could not terminalize the exact queued crawl.',
        );
      }
    }
    throw refusal;
  }

  context?.logger?.info?.('Starting source crawl.', {
    reason: args.reason ?? 'scheduled',
    sourceId: source.id,
  });

  try {
    let publicIntakeOptions = {};
    if (args.reason === 'url_intake') {
      try {
        publicIntakeOptions = await (
          await import('./url-intake-source-fetch.js')
        ).publicUrlIntakeCrawlOptions(String(source.url ?? ''));
      } catch (cause) {
        // The guarded root fetch precedes the crawler's durable crawl transition.
        // Settle only this exact queued request, under the existing native fence.
        if (sourceCrawlId && jobId) {
          const terminalized = await writeFence(
            async () =>
              await (
                dependencies.failRequestedCrawl ??
                failQueuedRequestedSourceCrawl
              )({
                error:
                  cause instanceof Error ? cause : new Error(String(cause)),
                jobId,
                sourceCrawlId,
                sourceId: String(source.id ?? ''),
              }),
          );
          if (!terminalized)
            throw new SourceCrawlOwnershipError(
              'Source crawl refused without ownership of its queued request.',
            );
        }
        throw cause;
      }
    }
    const summary = await crawlSource(source, {
      ...publicIntakeOptions,
      includeGeneric: args.includeGeneric !== false,
      writeFence: dependencies.writeFence,
      ...(args.runtimeWorkspaceSubject ? { intelligenceEnqueueCap: 0 } : {}),
      ...(jobId ? { jobId } : {}),
      ...(context?.job.attempt ? { jobAttempt: context.job.attempt } : {}),
      limit: Number.isFinite(limit) && limit > 0 ? limit : undefined,
      ...(sourceCrawlId ? { sourceCrawlId } : {}),
      signal: AbortSignal.timeout(SOURCE_CRAWL_TIMEOUT_MS),
    });
    source.lastCheckedAt = new Date();
    await writeFence(async () => {
      await syncSchedule(source, {
        saveSource: false,
        ...(args.runtimeWorkspaceSubject
          ? { runtimeWorkspaceSubject: args.runtimeWorkspaceSubject }
          : {}),
      });
      await source.save?.();
    });

    context?.logger?.info?.('Source crawl completed.', {
      candidates: summary.candidates,
      created: summary.created,
      duplicates: summary.duplicates,
      failedPersistence: summary.failedPersistence,
      intelligenceDuplicateSuppressed: summary.intelligenceDuplicateSuppressed,
      intelligenceEnqueued: summary.intelligenceEnqueued,
      intelligenceSkipped: summary.intelligenceSkipped,
      relisted: summary.relisted,
      reused: summary.reused,
      skipped: summary.skipped,
      sourceId: source.id,
    });

    return summary;
  } catch (error) {
    if (error instanceof SourceCrawlOwnershipError) {
      context?.logger?.error?.('Source crawl ownership refused.', {
        error: error.message,
        sourceId: source.id,
      });
      throw error;
    }
    source.lastCheckedAt = new Date();
    await writeFence(async () => {
      await syncSchedule(source, {
        saveSource: false,
        ...(args.runtimeWorkspaceSubject
          ? { runtimeWorkspaceSubject: args.runtimeWorkspaceSubject }
          : {}),
      });
      await source.save?.();
    });

    context?.logger?.error?.('Source crawl failed.', {
      error: error instanceof Error ? error.message : String(error),
      sourceId: source.id,
    });

    throw error;
  }
}
