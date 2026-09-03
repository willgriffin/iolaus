import { resolveDatabase } from '@happyvertical/smrt-core';
import { getDbConfig } from './db.js';
import {
  reconcileSourceCrawlAccountingTransaction,
  recoverPendingSourceCrawlAttempts,
} from './source-crawl-accounting.js';
import {
  SCHEDULED_SOURCE_QUEUE,
  SOURCE_CRAWL_METHOD,
  SOURCE_CRAWL_QUEUE,
  SOURCE_JOB_OBJECT_TYPE,
} from './source-schedules.js';

export const SOURCE_CRAWL_ACTIVE_JOB_INDEX =
  'idx_smrt_jobs_source_crawl_active';

type SmrtDatabase = Awaited<ReturnType<typeof resolveDatabase>>;
type QueryableDatabase = Pick<SmrtDatabase, 'query'>;

let dedupeIndexPromise: Promise<void> | null = null;

function normalizeIndexDefinition(value: unknown): string {
  return String(value ?? '')
    .toLowerCase()
    .replaceAll('"', '')
    .replace(/::(?:text|character varying)/g, '')
    .replace(/\b[a-z_][a-z0-9_]*\._smrt_jobs\b/g, '_smrt_jobs')
    .replace(/[\s()]+/g, '');
}

function expectedSourceCrawlActiveIndexDefinition(): string {
  return normalizeIndexDefinition(`
    CREATE UNIQUE INDEX ${SOURCE_CRAWL_ACTIVE_JOB_INDEX}
      ON _smrt_jobs USING btree (object_type, object_id, method)
      WHERE status = ANY (ARRAY['pending', 'running'])
        AND queue = ANY (ARRAY[${sqlString(SOURCE_CRAWL_QUEUE)}, ${sqlString(SCHEDULED_SOURCE_QUEUE)}])
        AND object_type = ${sqlString(SOURCE_JOB_OBJECT_TYPE)}
        AND method = ${sqlString(SOURCE_CRAWL_METHOD)}
        AND object_id IS NOT NULL
  `);
}

function sqlString(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

async function applySourceCrawlJobDedupe(db: SmrtDatabase): Promise<void> {
  if (typeof db.transaction !== 'function') {
    throw new Error('Source crawl job dedupe requires database transactions.');
  }
  await db.transaction(async (transaction) => {
    const installed = await getSourceCrawlJobDedupeStatus(transaction);
    if (installed.activeIndexNamed && !installed.activeIndexPresent) {
      await transaction.query(`DROP INDEX ${SOURCE_CRAWL_ACTIVE_JOB_INDEX}`);
    }

    const cancelled = await transaction.query(
      `
      WITH ranked AS (
        SELECT
          id,
          ROW_NUMBER() OVER (
            PARTITION BY object_type, object_id, method
            ORDER BY
              CASE WHEN status = 'running' THEN 0 ELSE 1 END ASC,
              priority DESC,
              run_at ASC,
              created_at ASC,
              id ASC
          ) AS duplicate_rank
        FROM _smrt_jobs
        WHERE status IN ('pending', 'running')
          AND queue IN (?, ?)
          AND object_type = ?
          AND method = ?
          AND object_id IS NOT NULL
      ), cancelled AS (
        UPDATE _smrt_jobs AS jobs
        SET status = 'cancelled',
            last_error = ?,
            worker_id = NULL,
            worker_heartbeat = NULL
        WHERE jobs.id IN (
          SELECT id FROM ranked WHERE duplicate_rank > 1
        )
          AND jobs.status = 'pending'
        RETURNING CAST(jobs.id AS TEXT) AS id,
                  CAST(jobs.object_id AS TEXT) AS object_id
      )
      SELECT id, object_id FROM cancelled
    `,
      [
        SOURCE_CRAWL_QUEUE,
        SCHEDULED_SOURCE_QUEUE,
        SOURCE_JOB_OBJECT_TYPE,
        SOURCE_CRAWL_METHOD,
        'Cancelled duplicate active source crawl job before enforcing active-job uniqueness.',
      ],
    );
    for (const job of cancelled.rows ?? []) {
      const jobId = String(job.id ?? '').trim();
      const sourceId = String(job.object_id ?? '').trim();
      if (!jobId || !sourceId) {
        throw new Error(
          'Cancelled source crawl job is missing its durable job/source binding.',
        );
      }
      const crawls = await transaction.query(
        `SELECT CAST(id AS TEXT) AS id,
                CAST(source_id AS TEXT) AS source_id,
                status
         FROM source_crawls
         WHERE job_id = ?
         FOR UPDATE`,
        [jobId],
      );
      for (const crawl of crawls.rows ?? []) {
        const crawlId = String(crawl.id ?? '').trim();
        const crawlSourceId = String(crawl.source_id ?? '').trim();
        if (!crawlId || !crawlSourceId || crawlSourceId !== sourceId) {
          throw new Error(
            `Cancelled source crawl job ${jobId} has a mismatched crawl/source binding.`,
          );
        }
        if (crawl.status !== 'queued' && crawl.status !== 'running') continue;
        await recoverPendingSourceCrawlAttempts(transaction, crawlId);
        await transaction.query(
          `UPDATE source_crawl_items
           SET outcome = 'failed_persistence',
               status = 'persistence_error',
               reason = ?,
               terminal_at = CURRENT_TIMESTAMP,
               updated_at = CURRENT_TIMESTAMP
           WHERE source_crawl_id = ? AND outcome = 'pending'`,
          [
            'Duplicate active source crawl was cancelled during schema reconciliation.',
            crawlId,
          ],
        );
        await reconcileSourceCrawlAccountingTransaction(transaction, crawlId);
        const terminalized = await transaction.query(
          `UPDATE source_crawls
           SET status = 'failed',
               error = ?,
               finished_at = CURRENT_TIMESTAMP,
               updated_at = CURRENT_TIMESTAMP
           WHERE id = ?
             AND job_id = ?
             AND CAST(source_id AS TEXT) = ?
             AND status IN ('queued', 'running')
           RETURNING id`,
          [
            'Duplicate active source crawl was cancelled during schema reconciliation.',
            crawlId,
            jobId,
            sourceId,
          ],
        );
        if (terminalized.rows?.length !== 1 && terminalized.rowCount !== 1) {
          throw new Error(
            `Cancelled source crawl job ${jobId} lost its exact crawl terminalization fence.`,
          );
        }
      }
    }

    await transaction.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS ${SOURCE_CRAWL_ACTIVE_JOB_INDEX}
        ON _smrt_jobs (object_type, object_id, method)
        WHERE status IN ('pending', 'running')
          AND queue IN (${sqlString(SOURCE_CRAWL_QUEUE)}, ${sqlString(SCHEDULED_SOURCE_QUEUE)})
          AND object_type = ${sqlString(SOURCE_JOB_OBJECT_TYPE)}
          AND method = ${sqlString(SOURCE_CRAWL_METHOD)}
          AND object_id IS NOT NULL
    `);

    const attested = await getSourceCrawlJobDedupeStatus(transaction);
    if (!attested.activeIndexPresent) {
      throw new Error('Source crawl active-job uniqueness index is not ready.');
    }
  });
}

export async function ensureSourceCrawlJobDedupe(
  db?: SmrtDatabase,
): Promise<void> {
  if (db) {
    await applySourceCrawlJobDedupe(db);
    return;
  }

  dedupeIndexPromise ??= resolveDatabase(getDbConfig())
    .then(applySourceCrawlJobDedupe)
    .catch((cause: unknown) => {
      dedupeIndexPromise = null;
      throw cause;
    });
  await dedupeIndexPromise;
}

export async function getSourceCrawlJobDedupeStatus(
  db: QueryableDatabase,
): Promise<{ activeIndexNamed: boolean; activeIndexPresent: boolean }> {
  const index = await db.query(
    `SELECT
       indexes.indisunique AS is_unique,
       indexes.indisvalid AS is_valid,
       indexes.indisready AS is_ready,
       pg_get_indexdef(indexes.indexrelid) AS index_definition
     FROM pg_class AS index_relation
     INNER JOIN pg_namespace AS index_namespace
       ON index_namespace.oid = index_relation.relnamespace
     INNER JOIN pg_index AS indexes
       ON indexes.indexrelid = index_relation.oid
     INNER JOIN pg_class AS table_relation
       ON table_relation.oid = indexes.indrelid
     INNER JOIN pg_namespace AS table_namespace
       ON table_namespace.oid = table_relation.relnamespace
     WHERE index_namespace.nspname = current_schema()
       AND table_namespace.nspname = current_schema()
       AND table_relation.relname = '_smrt_jobs'
       AND index_relation.relname = ?`,
    [SOURCE_CRAWL_ACTIVE_JOB_INDEX],
  );
  const row = index.rows[0] as Record<string, unknown> | undefined;
  const activeIndexNamed = index.rows.length === 1;
  const activeIndexPresent = Boolean(
    activeIndexNamed &&
      row?.is_unique === true &&
      row?.is_valid === true &&
      row?.is_ready === true &&
      normalizeIndexDefinition(row?.index_definition) ===
        expectedSourceCrawlActiveIndexDefinition(),
  );
  return { activeIndexNamed, activeIndexPresent };
}

export function isSourceCrawlActiveJobConflict(cause: unknown): boolean {
  const values: string[] = [];
  let cursor: unknown = cause;
  while (cursor && typeof cursor === 'object') {
    const record = cursor as Record<string, unknown>;
    for (const key of ['code', 'constraint', 'message']) {
      const value = record[key];
      if (typeof value === 'string') values.push(value);
    }
    cursor = record.cause;
  }
  return (
    values.some((value) =>
      /(?:^|\b)(?:code\s*[=:]\s*)?23505(?:\b|$)/i.test(value),
    ) && values.some((value) => value.includes(SOURCE_CRAWL_ACTIVE_JOB_INDEX))
  );
}
