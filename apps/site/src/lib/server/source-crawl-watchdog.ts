import { resolveDatabase } from '@happyvertical/smrt-core';
import { getDbConfig } from './db.js';
import {
  reconcileSourceCrawlAccountingTransaction,
  recoverPendingSourceCrawlAttempts,
  type SourceCrawlAccounting,
} from './source-crawl-accounting.js';
import {
  SCHEDULED_SOURCE_QUEUE,
  SOURCE_CRAWL_METHOD,
  SOURCE_CRAWL_QUEUE,
  SOURCE_CRAWL_TIMEOUT_MS,
  SOURCE_JOB_OBJECT_TYPE,
} from './source-schedules.js';

type SmrtDatabase = Awaited<ReturnType<typeof resolveDatabase>>;

function usesSqlite(): boolean {
  return getDbConfig().type === 'sqlite';
}

export const SOURCE_CRAWL_TIMEOUT_STATUS = 'timed_out';
export const SOURCE_CRAWL_TIMEOUT_ERROR =
  'Source crawl exceeded its configured execution timeout and was stopped by the watchdog.';
export const SOURCE_CRAWL_RECONCILIATION_BATCH_SIZE = 100;

export interface SourceCrawlWatchdogStatus {
  active: number;
  completed: number;
  failed: number;
  queued: number;
  recentTerminalErrors: Array<{
    error: string;
    finishedAt: string | null;
    id: string;
    status: string;
  }>;
  staleRunning: number;
  timedOut: number;
}

export interface SourceCrawlTerminalUpdate {
  error: string;
  fields?: Record<string, number | string>;
  status: 'completed' | 'completed_with_errors';
}

type SourceCrawlRecord = Record<string, unknown> & {
  db?: { query?: (...args: unknown[]) => Promise<{ rowCount?: number }> };
  finishedAt?: Date | null;
  id?: unknown;
  jobAttempt?: unknown;
  jobId?: unknown;
  save?: () => Promise<unknown>;
  status?: string;
};

function sourceCrawlId(crawl: SourceCrawlRecord): string {
  return typeof crawl.id === 'string' &&
    crawl.id.length > 0 &&
    crawl.id === crawl.id.trim()
    ? crawl.id
    : '';
}

function sourceCrawlOwner(crawl: SourceCrawlRecord): {
  attempt: number;
  jobId: string;
} | null {
  const jobId =
    typeof crawl.jobId === 'string' &&
    crawl.jobId.length > 0 &&
    crawl.jobId === crawl.jobId.trim()
      ? crawl.jobId
      : '';
  const attempt = crawl.jobAttempt;
  return jobId &&
    typeof attempt === 'number' &&
    Number.isInteger(attempt) &&
    attempt > 0
    ? { attempt, jobId }
    : null;
}

function hasExactManualCrawlBinding(crawl: SourceCrawlRecord): boolean {
  return crawl.jobId === '' && crawl.jobAttempt === 0;
}

function recordDatabase(
  crawl: SourceCrawlRecord,
): { query?: (...args: unknown[]) => Promise<{ rowCount?: number }> } | null {
  try {
    return crawl.db ?? null;
  } catch {
    // Test doubles and non-persisted records do not expose a SMRT database.
    return null;
  }
}

function boundedErrorContext(value: unknown): string {
  const sanitized = String(value ?? '')
    .replace(
      /((?:api[-_]?key|authorization|cookie|password|secret|session|token)\s*(?:=|:)\s*)(?:Bearer\s+)?[^\s,;]+/gi,
      '$1[redacted]',
    )
    .replace(/(https?:\/\/)[^/\s@]+@/gi, '$1[redacted]@')
    .replace(
      /([?&](?:api[-_]?key|password|secret|session|token)=)[^&#\s]+/gi,
      '$1[redacted]',
    );
  if (sanitized.length <= 240) return sanitized;
  return `${sanitized.slice(0, 120)}…${sanitized.slice(-119)}`;
}

/**
 * Applies a crawl's terminal state only while it still owns the running state.
 * This is the fence that prevents a timed-out handler from later overwriting a
 * watchdog timeout with a misleading success or ordinary failure.
 */
export async function finalizeSourceCrawl(
  crawl: SourceCrawlRecord | null,
  update: SourceCrawlTerminalUpdate,
): Promise<boolean> {
  if (!crawl) return false;

  const id = sourceCrawlId(crawl);
  const db = recordDatabase(crawl);
  const finishedAt = new Date();
  const fields = update.fields ?? {};
  const owner = sourceCrawlOwner(crawl);

  if (id && db?.query) {
    if (!owner && !hasExactManualCrawlBinding(crawl)) return false;
    const ownershipClause = owner
      ? 'AND job_id = ? AND job_attempt = ?'
      : "AND job_id = '' AND job_attempt = 0";
    const ownershipParameters = owner ? [owner.jobId, owner.attempt] : [];
    const result = await db.query(
      `
        UPDATE source_crawls
          SET status = ?,
              finished_at = ?,
              error = ?,
              result_count = COALESCE(?, result_count),
              new_opportunity_count = COALESCE(?, new_opportunity_count),
              duplicate_count = COALESCE(?, duplicate_count),
              skipped_count = COALESCE(?, skipped_count),
              intelligence_enqueued_count = COALESCE(?, intelligence_enqueued_count),
              intelligence_duplicate_count = COALESCE(?, intelligence_duplicate_count),
              intelligence_skipped_count = COALESCE(?, intelligence_skipped_count),
              updated_at = CURRENT_TIMESTAMP
          WHERE id = ?
            AND status = 'running'
            AND finished_at IS NULL
            ${ownershipClause}
          RETURNING id
      `,
      [
        update.status,
        finishedAt,
        update.error,
        fields.resultCount ?? null,
        fields.newOpportunityCount ?? null,
        fields.duplicateCount ?? null,
        fields.skippedCount ?? null,
        fields.intelligenceEnqueuedCount ?? null,
        fields.intelligenceDuplicateCount ?? null,
        fields.intelligenceSkippedCount ?? null,
        id,
        ...ownershipParameters,
      ],
    );
    if ((result.rowCount ?? 0) <= 0) return false;
  } else {
    // Retain the in-memory fallback used by crawler unit tests and dry local
    // harnesses. Production-backed crawls always use the fenced UPDATE above.
    if (crawl.status !== 'running' || crawl.finishedAt) return false;
  }

  crawl.status = update.status;
  crawl.finishedAt = finishedAt;
  crawl.error = update.error;
  Object.assign(crawl, fields);
  if (!db?.query) await crawl.save?.();
  return true;
}

/**
 * Atomically reconcile a successful crawl and close its parent fence. Holding
 * the parent lock from reconciliation through the terminal update prevents a
 * late candidate attempt from appearing between those two operations.
 */
export async function completeSourceCrawl(
  crawl: SourceCrawlRecord | null,
  update: SourceCrawlTerminalUpdate,
  database?: SmrtDatabase,
): Promise<boolean> {
  if (!crawl) return false;
  const id = sourceCrawlId(crawl);
  if (!id) return false;
  const db = database ?? (await resolveDatabase(getDbConfig()));
  if (typeof db.transaction !== 'function') {
    return await finalizeSourceCrawl(crawl, update);
  }
  const finishedAt = new Date();
  const owner = sourceCrawlOwner(crawl);
  if (!owner && !hasExactManualCrawlBinding(crawl)) return false;
  const ownershipClause = owner
    ? 'AND job_id = ? AND job_attempt = ?'
    : "AND job_id = '' AND job_attempt = 0";
  const ownershipParameters = owner ? [owner.jobId, owner.attempt] : [];
  let accounting: SourceCrawlAccounting | null = null;
  const finalized = await db.transaction(async (transaction) => {
    const locked = await transaction.query(
      `SELECT id FROM source_crawls
       WHERE id = ? AND status = 'running' AND finished_at IS NULL
         ${ownershipClause}${usesSqlite() ? '' : '\n       FOR UPDATE'}`,
      [id, ...ownershipParameters],
    );
    if (locked.rows.length !== 1) return false;
    accounting = await reconcileSourceCrawlAccountingTransaction(
      transaction,
      id,
    );
    if (accounting.pendingCount > 0) {
      throw new Error(
        `Source crawl ${id} has ${accounting.pendingCount} non-terminal attempts.`,
      );
    }
    const fields = update.fields ?? {};
    await transaction.query(
      `UPDATE source_crawls
       SET status = ?, finished_at = ?, error = ?,
           intelligence_enqueued_count = COALESCE(?, intelligence_enqueued_count),
           intelligence_duplicate_count = COALESCE(?, intelligence_duplicate_count),
           intelligence_skipped_count = COALESCE(?, intelligence_skipped_count),
           updated_at = CURRENT_TIMESTAMP
       WHERE id = ?`,
      [
        update.status,
        finishedAt,
        update.error,
        fields.intelligenceEnqueuedCount ?? null,
        fields.intelligenceDuplicateCount ?? null,
        fields.intelligenceSkippedCount ?? null,
        id,
      ],
    );
    return true;
  });
  if (!finalized) {
    const actual = await db.query(
      `SELECT status, finished_at AS "finishedAt", COALESCE(error, '') AS error
       FROM source_crawls WHERE id = ?`,
      [id],
    );
    const state = actual.rows[0];
    if (state) {
      crawl.status = String(state.status ?? crawl.status);
      const actualFinishedAt = state.finishedAt;
      crawl.finishedAt = actualFinishedAt
        ? actualFinishedAt instanceof Date
          ? actualFinishedAt
          : new Date(String(actualFinishedAt))
        : null;
      crawl.error = String(state.error ?? crawl.error ?? '');
    }
    return false;
  }
  crawl.status = update.status;
  crawl.finishedAt = finishedAt;
  crawl.error = update.error;
  Object.assign(crawl, update.fields ?? {}, accounting ?? {});
  return true;
}

/** Atomically fails a running crawl, its pending attempts, and its aggregates. */
export async function failSourceCrawl(
  crawl: SourceCrawlRecord | null,
  error: unknown,
  database?: SmrtDatabase,
): Promise<boolean> {
  if (!crawl) return false;
  const id = sourceCrawlId(crawl);
  if (!id) return false;
  const db = database ?? (await resolveDatabase(getDbConfig()));
  if (typeof db.transaction !== 'function') {
    if (crawl.status !== 'running' || crawl.finishedAt) return false;
    const finishedAt = new Date();
    crawl.status = 'failed';
    crawl.finishedAt = finishedAt;
    crawl.error = boundedErrorContext(error);
    await crawl.save?.();
    return true;
  }
  const finishedAt = new Date();
  const reason = boundedErrorContext(error);
  const owner = sourceCrawlOwner(crawl);
  if (!owner && !hasExactManualCrawlBinding(crawl)) return false;
  const ownershipClause = owner
    ? 'AND job_id = ? AND job_attempt = ?'
    : "AND job_id = '' AND job_attempt = 0";
  const ownershipParameters = owner ? [owner.jobId, owner.attempt] : [];
  const finalized = await db.transaction(async (transaction) => {
    const locked = await transaction.query(
      `SELECT id FROM source_crawls
       WHERE id = ? AND status = 'running' AND finished_at IS NULL
         ${ownershipClause}${usesSqlite() ? '' : '\n       FOR UPDATE'}`,
      [id, ...ownershipParameters],
    );
    if (locked.rows.length !== 1) return false;
    await recoverPendingSourceCrawlAttempts(transaction, id, finishedAt);
    await transaction.query(
      `UPDATE source_crawl_items
       SET outcome = 'failed_persistence',
           status = 'persistence_error',
           reason = ?,
           terminal_at = ?,
           updated_at = CURRENT_TIMESTAMP
       WHERE source_crawl_id = ? AND outcome = 'pending'`,
      [reason, finishedAt, id],
    );
    await transaction.query(
      `UPDATE source_crawls
       SET status = 'failed', finished_at = ?, error = ?,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = ?`,
      [finishedAt, reason, id],
    );
    await reconcileSourceCrawlAccountingTransaction(transaction, id);
    return true;
  });
  if (!finalized) return false;
  crawl.status = 'failed';
  crawl.finishedAt = finishedAt;
  crawl.error = reason;
  return true;
}

function sourceCrawlIds(
  rows: Array<Record<string, unknown>> | undefined,
): string[] {
  return (rows ?? []).flatMap((row) => {
    const id = row.id;
    return typeof id === 'string' && id.length > 0 && id === id.trim()
      ? [id]
      : [];
  });
}

function reportIsolatedSourceCrawlRecoveryFailure(
  phase: 'queued' | 'timeout',
  crawlId: string,
  error: unknown,
): void {
  console.error(
    '[source-crawl-watchdog] isolated irrecoverable crawl recovery; left the crawl unchanged. Inspect source-crawl accounting before retrying.',
    {
      crawlId: boundedErrorContext(crawlId),
      error: boundedErrorContext(error),
      phase,
    },
  );
}

async function reconcileInterruptedQueuedSourceCrawl(
  db: SmrtDatabase,
  crawlId: string,
  now: Date,
): Promise<void> {
  if (typeof db.transaction !== 'function') return;
  await db.transaction(async (transaction) => {
    const interruptedQueued = await transaction.query(
      `WITH interrupted_queued AS (
         SELECT crawl.id
         FROM source_crawls AS crawl
         WHERE CAST(crawl.id AS TEXT) = ?
           AND crawl.status = 'queued'
           AND crawl.finished_at IS NULL
           AND EXISTS (
             SELECT 1 FROM _smrt_jobs AS job
             WHERE CAST(job.id AS TEXT) = crawl.job_id
               AND NULLIF(CAST(crawl.job_id AS TEXT), '') IS NOT NULL
               AND CAST(crawl.job_id AS TEXT) = BTRIM(CAST(crawl.job_id AS TEXT))
               AND NULLIF(CAST(job.object_id AS TEXT), '') IS NOT NULL
               AND CAST(job.object_id AS TEXT) = BTRIM(CAST(job.object_id AS TEXT))
               AND NULLIF(CAST(crawl.source_id AS TEXT), '') IS NOT NULL
               AND CAST(crawl.source_id AS TEXT) = BTRIM(CAST(crawl.source_id AS TEXT))
               AND CAST(job.object_id AS TEXT) = CAST(crawl.source_id AS TEXT)
               AND (
                 COALESCE(crawl.job_attempt, 0) = 0
                 OR job.attempts = crawl.job_attempt
               )
               AND job.status IN ('completed', 'failed', 'cancelled')
               AND job.queue IN (?, ?)
               AND job.object_type = ?
               AND job.method = ?
           )
         FOR UPDATE OF crawl SKIP LOCKED
       )
       UPDATE source_crawls AS crawl
       SET status = 'failed',
           finished_at = ?,
           error = ?,
           updated_at = ?
       FROM interrupted_queued
       WHERE crawl.id = interrupted_queued.id
         AND crawl.status = 'queued'
         AND crawl.finished_at IS NULL
       RETURNING CAST(crawl.id AS TEXT) AS id`,
      [
        crawlId,
        SOURCE_CRAWL_QUEUE,
        SCHEDULED_SOURCE_QUEUE,
        SOURCE_JOB_OBJECT_TYPE,
        SOURCE_CRAWL_METHOD,
        now,
        'Source crawl job ended before execution recorded a running crawl.',
        now,
      ],
    );
    for (const id of sourceCrawlIds(interruptedQueued.rows)) {
      await reconcileSourceCrawlAccountingTransaction(transaction, id);
    }
  });
}

async function reapStaleSourceCrawl(
  db: SmrtDatabase,
  crawlId: string,
  deadline: Date,
  now: Date,
): Promise<number> {
  if (typeof db.transaction !== 'function') return 0;
  return await db.transaction(async (transaction) => {
    const stale = await transaction.query(
      `SELECT CAST(crawl.id AS TEXT) AS id
       FROM source_crawls AS crawl
       WHERE CAST(crawl.id AS TEXT) = ?
         AND crawl.status = 'running' AND crawl.finished_at IS NULL
         AND crawl.started_at IS NOT NULL AND crawl.started_at <= ?
         AND (
           (crawl.job_id = '' AND crawl.job_attempt = 0
             AND NULLIF(CAST(crawl.source_id AS TEXT), '') IS NOT NULL
             AND CAST(crawl.source_id AS TEXT) = BTRIM(CAST(crawl.source_id AS TEXT)))
           OR EXISTS (
             SELECT 1 FROM _smrt_jobs AS job
             WHERE CAST(job.id AS TEXT) = crawl.job_id
               AND NULLIF(CAST(crawl.job_id AS TEXT), '') IS NOT NULL
               AND CAST(crawl.job_id AS TEXT) = BTRIM(CAST(crawl.job_id AS TEXT))
               AND NULLIF(CAST(crawl.source_id AS TEXT), '') IS NOT NULL
               AND CAST(crawl.source_id AS TEXT) = BTRIM(CAST(crawl.source_id AS TEXT))
               AND CAST(job.object_id AS TEXT) = CAST(crawl.source_id AS TEXT)
               AND crawl.job_attempt > 0 AND job.attempts = crawl.job_attempt
               AND job.status IN ('running', 'completed', 'failed', 'cancelled')
               AND job.queue IN (?, ?)
               AND job.object_type = ? AND job.method = ?
           )
         )
       FOR UPDATE SKIP LOCKED`,
      [
        crawlId,
        deadline,
        SOURCE_CRAWL_QUEUE,
        SCHEDULED_SOURCE_QUEUE,
        SOURCE_JOB_OBJECT_TYPE,
        SOURCE_CRAWL_METHOD,
      ],
    );
    const staleIds = sourceCrawlIds(stale.rows);
    if (staleIds.length !== 1) return 0;
    await recoverPendingSourceCrawlAttempts(transaction, staleIds[0], now);
    const result = await transaction.query(
      `
      WITH stale_crawls AS (
        SELECT id, job_id, source_id, job_attempt
        FROM source_crawls
        WHERE CAST(id AS TEXT) = ?
          AND status = 'running'
          AND finished_at IS NULL
          AND started_at IS NOT NULL
          AND started_at <= ?
          AND (
            (job_id = '' AND job_attempt = 0
              AND NULLIF(CAST(source_crawls.source_id AS TEXT), '') IS NOT NULL
              AND CAST(source_crawls.source_id AS TEXT) = BTRIM(CAST(source_crawls.source_id AS TEXT)))
            OR EXISTS (
              SELECT 1 FROM _smrt_jobs AS owner
              WHERE CAST(owner.id AS TEXT) = source_crawls.job_id
                AND NULLIF(CAST(source_crawls.job_id AS TEXT), '') IS NOT NULL
                AND CAST(source_crawls.job_id AS TEXT) = BTRIM(CAST(source_crawls.job_id AS TEXT))
                AND NULLIF(CAST(source_crawls.source_id AS TEXT), '') IS NOT NULL
                AND CAST(source_crawls.source_id AS TEXT) = BTRIM(CAST(source_crawls.source_id AS TEXT))
                AND CAST(owner.object_id AS TEXT) = CAST(source_crawls.source_id AS TEXT)
                AND source_crawls.job_attempt > 0
                AND owner.attempts = source_crawls.job_attempt
                AND owner.status IN ('running', 'completed', 'failed', 'cancelled')
                AND owner.queue IN (?, ?)
                AND owner.object_type = ? AND owner.method = ?
            )
          )
        FOR UPDATE SKIP LOCKED
      ), failed_jobs AS (
        UPDATE _smrt_jobs AS job
        SET status = 'failed',
            completed_at = ?,
            last_error = ?,
            worker_id = NULL,
            worker_heartbeat = NULL,
            updated_at = ?
        FROM stale_crawls AS crawl
        WHERE CAST(job.id AS TEXT) = crawl.job_id
          AND NULLIF(CAST(job.object_id AS TEXT), '') IS NOT NULL
          AND CAST(job.object_id AS TEXT) = BTRIM(CAST(job.object_id AS TEXT))
          AND NULLIF(CAST(crawl.source_id AS TEXT), '') IS NOT NULL
          AND CAST(crawl.source_id AS TEXT) = BTRIM(CAST(crawl.source_id AS TEXT))
          AND CAST(job.object_id AS TEXT) = CAST(crawl.source_id AS TEXT)
          AND crawl.job_attempt > 0
          AND job.attempts = crawl.job_attempt
          AND job.status = 'running'
          AND job.queue IN (?, ?)
          AND job.object_type = ?
          AND job.method = ?
      ), failed_attempts AS (
        UPDATE source_crawl_items AS item
        SET outcome = 'failed_persistence',
            status = 'persistence_error',
            reason = ?,
            terminal_at = ?,
            updated_at = ?
        FROM stale_crawls AS crawl
        WHERE item.source_crawl_id = CAST(crawl.id AS TEXT)
          AND item.outcome = 'pending'
      )
      UPDATE source_crawls AS crawl
      SET status = ?,
          finished_at = ?,
          error = ?,
          updated_at = ?
      FROM stale_crawls AS stale
      WHERE crawl.id = stale.id
        AND crawl.status = 'running'
        AND crawl.finished_at IS NULL
      RETURNING CAST(crawl.id AS TEXT) AS id
    `,
      [
        crawlId,
        deadline,
        SOURCE_CRAWL_QUEUE,
        SCHEDULED_SOURCE_QUEUE,
        SOURCE_JOB_OBJECT_TYPE,
        SOURCE_CRAWL_METHOD,
        now,
        SOURCE_CRAWL_TIMEOUT_ERROR,
        now,
        SOURCE_CRAWL_QUEUE,
        SCHEDULED_SOURCE_QUEUE,
        SOURCE_JOB_OBJECT_TYPE,
        SOURCE_CRAWL_METHOD,
        SOURCE_CRAWL_TIMEOUT_ERROR,
        now,
        now,
        SOURCE_CRAWL_TIMEOUT_STATUS,
        now,
        SOURCE_CRAWL_TIMEOUT_ERROR,
        now,
      ],
    );
    for (const id of sourceCrawlIds(result.rows)) {
      await reconcileSourceCrawlAccountingTransaction(transaction, id);
    }
    return Math.max(0, result.rowCount ?? result.rows?.length ?? 0);
  });
}

/**
 * Marks overdue crawls terminal. Each candidate owns an independent
 * transaction: a legacy accounting invariant can therefore roll back its own
 * recovery without aborting worker startup or another candidate's recovery.
 */
export async function reapStaleSourceCrawls(
  database?: SmrtDatabase,
  now = new Date(),
): Promise<{ timedOut: number }> {
  const db = database ?? (await resolveDatabase(getDbConfig()));
  const deadline = new Date(now.getTime() - SOURCE_CRAWL_TIMEOUT_MS);
  if (typeof db.transaction !== 'function') {
    throw new Error('Source crawl watchdog requires database transactions.');
  }

  const interruptedQueued = await db.query(
    `SELECT CAST(crawl.id AS TEXT) AS id
     FROM source_crawls AS crawl
     WHERE crawl.status = 'queued'
       AND crawl.finished_at IS NULL
       AND EXISTS (
         SELECT 1 FROM _smrt_jobs AS job
         WHERE CAST(job.id AS TEXT) = crawl.job_id
           AND NULLIF(CAST(crawl.job_id AS TEXT), '') IS NOT NULL
           AND CAST(crawl.job_id AS TEXT) = BTRIM(CAST(crawl.job_id AS TEXT))
           AND NULLIF(CAST(job.object_id AS TEXT), '') IS NOT NULL
           AND CAST(job.object_id AS TEXT) = BTRIM(CAST(job.object_id AS TEXT))
           AND NULLIF(CAST(crawl.source_id AS TEXT), '') IS NOT NULL
           AND CAST(crawl.source_id AS TEXT) = BTRIM(CAST(crawl.source_id AS TEXT))
           AND CAST(job.object_id AS TEXT) = CAST(crawl.source_id AS TEXT)
           AND (
             COALESCE(crawl.job_attempt, 0) = 0
             OR job.attempts = crawl.job_attempt
           )
           AND job.status IN ('completed', 'failed', 'cancelled')
           AND job.queue IN (?, ?)
           AND job.object_type = ?
           AND job.method = ?
       )
     ORDER BY crawl.created_at ASC, crawl.id ASC
     LIMIT ?`,
    [
      SOURCE_CRAWL_QUEUE,
      SCHEDULED_SOURCE_QUEUE,
      SOURCE_JOB_OBJECT_TYPE,
      SOURCE_CRAWL_METHOD,
      SOURCE_CRAWL_RECONCILIATION_BATCH_SIZE,
    ],
  );
  for (const crawlId of sourceCrawlIds(interruptedQueued.rows)) {
    try {
      await reconcileInterruptedQueuedSourceCrawl(db, crawlId, now);
    } catch (error) {
      reportIsolatedSourceCrawlRecoveryFailure('queued', crawlId, error);
    }
  }

  const stale = await db.query(
    `SELECT CAST(crawl.id AS TEXT) AS id
     FROM source_crawls AS crawl
     WHERE crawl.status = 'running' AND crawl.finished_at IS NULL
       AND crawl.started_at IS NOT NULL AND crawl.started_at <= ?
       AND (
         (crawl.job_id = '' AND crawl.job_attempt = 0
           AND NULLIF(CAST(crawl.source_id AS TEXT), '') IS NOT NULL
           AND CAST(crawl.source_id AS TEXT) = BTRIM(CAST(crawl.source_id AS TEXT)))
         OR EXISTS (
           SELECT 1 FROM _smrt_jobs AS job
           WHERE CAST(job.id AS TEXT) = crawl.job_id
             AND NULLIF(CAST(crawl.job_id AS TEXT), '') IS NOT NULL
             AND CAST(crawl.job_id AS TEXT) = BTRIM(CAST(crawl.job_id AS TEXT))
             AND NULLIF(CAST(crawl.source_id AS TEXT), '') IS NOT NULL
             AND CAST(crawl.source_id AS TEXT) = BTRIM(CAST(crawl.source_id AS TEXT))
             AND CAST(job.object_id AS TEXT) = CAST(crawl.source_id AS TEXT)
             AND crawl.job_attempt > 0 AND job.attempts = crawl.job_attempt
             AND job.status IN ('running', 'completed', 'failed', 'cancelled')
             AND job.queue IN (?, ?)
             AND job.object_type = ? AND job.method = ?
         )
       )
     ORDER BY crawl.started_at ASC, crawl.id ASC`,
    [
      deadline,
      SOURCE_CRAWL_QUEUE,
      SCHEDULED_SOURCE_QUEUE,
      SOURCE_JOB_OBJECT_TYPE,
      SOURCE_CRAWL_METHOD,
    ],
  );
  let timedOut = 0;
  for (const crawlId of sourceCrawlIds(stale.rows)) {
    try {
      timedOut += await reapStaleSourceCrawl(db, crawlId, deadline, now);
    } catch (error) {
      reportIsolatedSourceCrawlRecoveryFailure('timeout', crawlId, error);
    }
  }
  return { timedOut };
}

/** Reconciles an interrupted or terminal job without treating it as success. */
export async function reconcileFailedSourceCrawlJob(
  jobId: string,
  database?: SmrtDatabase,
  now = new Date(),
): Promise<{ markedFailed: number }> {
  if (
    typeof jobId !== 'string' ||
    jobId.length === 0 ||
    jobId !== jobId.trim()
  ) {
    return { markedFailed: 0 };
  }

  const db = database ?? (await resolveDatabase(getDbConfig()));
  const failureReason =
    'Source crawl job ended before a terminal crawl result was recorded.';
  if (typeof db.transaction !== 'function') {
    throw new Error('Source crawl watchdog requires database transactions.');
  }
  return await db.transaction(async (transaction) => {
    const interrupted = await transaction.query(
      `SELECT CAST(crawl.id AS TEXT) AS id
       FROM source_crawls AS crawl
       WHERE crawl.job_id = ?
         AND crawl.status IN ('queued', 'running')
         AND crawl.finished_at IS NULL
         AND NULLIF(CAST(crawl.job_id AS TEXT), '') IS NOT NULL
         AND CAST(crawl.job_id AS TEXT) = BTRIM(CAST(crawl.job_id AS TEXT))
         AND EXISTS (
           SELECT 1 FROM _smrt_jobs AS job
           WHERE CAST(job.id AS TEXT) = ?
             AND NULLIF(CAST(job.object_id AS TEXT), '') IS NOT NULL
             AND CAST(job.object_id AS TEXT) = BTRIM(CAST(job.object_id AS TEXT))
             AND NULLIF(CAST(crawl.source_id AS TEXT), '') IS NOT NULL
             AND CAST(crawl.source_id AS TEXT) = BTRIM(CAST(crawl.source_id AS TEXT))
             AND CAST(job.object_id AS TEXT) = CAST(crawl.source_id AS TEXT)
             AND (
               (crawl.status = 'queued' AND COALESCE(crawl.job_attempt, 0) = 0)
               OR (crawl.job_attempt > 0 AND job.attempts = crawl.job_attempt)
             )
             AND job.status IN ('failed', 'cancelled')
             AND job.queue IN (?, ?)
             AND job.object_type = ?
             AND job.method = ?
         )
       FOR UPDATE`,
      [
        jobId,
        jobId,
        SOURCE_CRAWL_QUEUE,
        SCHEDULED_SOURCE_QUEUE,
        SOURCE_JOB_OBJECT_TYPE,
        SOURCE_CRAWL_METHOD,
      ],
    );
    for (const row of interrupted.rows ?? []) {
      const id = typeof row.id === 'string' ? row.id : '';
      if (id) await recoverPendingSourceCrawlAttempts(transaction, id, now);
    }
    const result = await transaction.query(
      `
      WITH failed_crawls AS (
        SELECT crawl.id
        FROM source_crawls AS crawl
        WHERE crawl.job_id = ?
          AND crawl.status IN ('queued', 'running')
          AND crawl.finished_at IS NULL
          AND NULLIF(CAST(crawl.job_id AS TEXT), '') IS NOT NULL
          AND CAST(crawl.job_id AS TEXT) = BTRIM(CAST(crawl.job_id AS TEXT))
          AND EXISTS (
          SELECT 1
          FROM _smrt_jobs AS job
          WHERE CAST(job.id AS TEXT) = ?
            AND NULLIF(CAST(job.object_id AS TEXT), '') IS NOT NULL
            AND CAST(job.object_id AS TEXT) = BTRIM(CAST(job.object_id AS TEXT))
            AND NULLIF(CAST(crawl.source_id AS TEXT), '') IS NOT NULL
            AND CAST(crawl.source_id AS TEXT) = BTRIM(CAST(crawl.source_id AS TEXT))
            AND CAST(job.object_id AS TEXT) = CAST(crawl.source_id AS TEXT)
            AND (
              (crawl.status = 'queued' AND COALESCE(crawl.job_attempt, 0) = 0)
              OR (crawl.job_attempt > 0 AND job.attempts = crawl.job_attempt)
            )
            AND job.status IN ('failed', 'cancelled')
            AND job.queue IN (?, ?)
            AND job.object_type = ?
            AND job.method = ?
        )
        FOR UPDATE
      ), failed_attempts AS (
        UPDATE source_crawl_items AS item
        SET outcome = 'failed_persistence',
            status = 'persistence_error',
            reason = ?,
            terminal_at = ?,
            updated_at = ?
        FROM failed_crawls AS crawl
        WHERE item.source_crawl_id = CAST(crawl.id AS TEXT)
          AND item.outcome = 'pending'
      )
      UPDATE source_crawls AS crawl
      SET status = 'failed',
          finished_at = ?,
          error = ?,
          updated_at = ?
      FROM failed_crawls AS failed
      WHERE crawl.id = failed.id
      RETURNING CAST(crawl.id AS TEXT) AS id
    `,
      [
        jobId,
        jobId,
        SOURCE_CRAWL_QUEUE,
        SCHEDULED_SOURCE_QUEUE,
        SOURCE_JOB_OBJECT_TYPE,
        SOURCE_CRAWL_METHOD,
        failureReason,
        now,
        now,
        now,
        failureReason,
        now,
      ],
    );
    for (const row of result.rows ?? []) {
      const id = typeof row.id === 'string' ? row.id : '';
      if (id) await reconcileSourceCrawlAccountingTransaction(transaction, id);
    }
    return { markedFailed: Math.max(0, result.rowCount ?? 0) };
  });
}

export async function getSourceCrawlWatchdogStatus(
  database?: SmrtDatabase,
  now = new Date(),
): Promise<SourceCrawlWatchdogStatus> {
  const db = database ?? (await resolveDatabase(getDbConfig()));
  const deadline = new Date(now.getTime() - SOURCE_CRAWL_TIMEOUT_MS);
  const result = await db.query(
    `
      SELECT
        COUNT(*) FILTER (WHERE status IN ('queued', 'pending')) AS queued,
        COUNT(*) FILTER (
          WHERE status = 'running'
            AND finished_at IS NULL
            AND started_at > ?
        ) AS active,
        COUNT(*) FILTER (
          WHERE status = 'running'
            AND finished_at IS NULL
            AND (started_at IS NULL OR started_at <= ?)
        ) AS stale_running,
        COUNT(*) FILTER (WHERE status IN ('completed', 'completed_with_errors')) AS completed,
        COUNT(*) FILTER (WHERE status = 'failed') AS failed,
        COUNT(*) FILTER (WHERE status = ?) AS timed_out
      FROM source_crawls
    `,
    [deadline, deadline, SOURCE_CRAWL_TIMEOUT_STATUS],
  );
  const row = result.rows?.[0] ?? {};
  const recentErrors = await db.query(
    `
      SELECT
        CAST(id AS TEXT) AS id,
        status,
        LEFT(COALESCE(error, ''), 240) AS error,
        finished_at
      FROM source_crawls
      WHERE status IN ('failed', ?)
        AND error IS NOT NULL
        AND error <> ''
      ORDER BY finished_at DESC NULLS LAST, created_at DESC
      LIMIT 10
    `,
    [SOURCE_CRAWL_TIMEOUT_STATUS],
  );
  const count = (value: unknown) => Math.max(0, Number(value) || 0);
  return {
    active: count(row.active),
    completed: count(row.completed),
    failed: count(row.failed),
    queued: count(row.queued),
    recentTerminalErrors: (recentErrors.rows ?? [])
      .slice(0, 10)
      .map((error) => ({
        error: boundedErrorContext(error.error),
        finishedAt: error.finished_at ? String(error.finished_at) : null,
        id: String(error.id ?? ''),
        status: String(error.status ?? ''),
      })),
    staleRunning: count(row.stale_running),
    timedOut: count(row.timed_out),
  };
}
