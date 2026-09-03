import { createHash, randomUUID } from 'node:crypto';
import type { resolveDatabase } from '@happyvertical/smrt-core';
import {
  reconcileSourceCrawlAccountingTransaction,
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

export const SOURCE_CRAWL_PARENT_RECOVERY_VERSION =
  '20260901_source_crawl_parent_recovery_v1';

interface ParentRecoveryRows {
  crawlBefore: Record<string, unknown>;
  itemBefore: Record<string, unknown>[];
  jobBefore: Record<string, unknown> | null;
  startedAtEpochMs?: number;
}

export interface SourceCrawlParentRecoveryAttestation {
  crawlId: string;
  planSha256: string;
}

export interface SourceCrawlParentRecoveryPlan {
  crawlId: string;
  eligible: boolean;
  fingerprint: string;
  itemCount: number;
  jobPresent: boolean;
  reason: string;
  sourceId: string;
  version: typeof SOURCE_CRAWL_PARENT_RECOVERY_VERSION;
}

export interface SourceCrawlParentRecoveryResult {
  accounting: SourceCrawlAccounting;
  archivedRows: number;
  crawlId: string;
  fingerprint: string;
  repairId: string;
  status: 'timed_out';
}

/** Inspect one exact legacy parent crawl without exposing its archived rows. */
export async function inspectSourceCrawlParentRecovery(
  db: Pick<SmrtDatabase, 'query'>,
  input: { crawlId: string; now?: Date },
): Promise<SourceCrawlParentRecoveryPlan> {
  const crawlId = exactId(input.crawlId);
  return planFromRows(
    crawlId,
    await selectRows(db, crawlId),
    validNow(input.now),
  );
}

export async function inspectSourceCrawlParentRecoveryAttestation(
  db: Pick<SmrtDatabase, 'query'>,
  input: { crawlId: string; now?: Date },
): Promise<SourceCrawlParentRecoveryAttestation> {
  const plan = await inspectSourceCrawlParentRecovery(db, input);
  if (!plan.eligible) {
    throw new Error(
      `Source crawl ${plan.crawlId} is not eligible for parent recovery: ${plan.reason}`,
    );
  }
  return { crawlId: plan.crawlId, planSha256: plan.fingerprint };
}

/**
 * Terminalize one operator-selected legacy parent whose worker ownership can
 * no longer become active. No success or Opportunity provenance is inferred.
 */
export async function applySourceCrawlParentRecovery(
  db: SmrtDatabase,
  input: {
    backupSha256: string;
    crawlId: string;
    expectedFingerprint: string;
    now?: Date;
    reason: string;
  },
): Promise<SourceCrawlParentRecoveryResult> {
  const crawlId = exactId(input.crawlId);
  const now = validNow(input.now);
  const reason = boundedReason(input.reason);
  assertSha256(input.backupSha256, 'backup');
  assertSha256(input.expectedFingerprint, 'plan');
  if (typeof db.transaction !== 'function') {
    throw new Error('Source crawl parent recovery requires a transaction.');
  }
  const repairId = `${SOURCE_CRAWL_PARENT_RECOVERY_VERSION}:${input.expectedFingerprint}`;

  return await db.transaction(async (transaction) => {
    await transaction.query("SET LOCAL lock_timeout = '15s'");
    await transaction.query('SELECT pg_advisory_xact_lock(hashtext(?))', [
      `${SOURCE_CRAWL_PARENT_RECOVERY_VERSION}:${crawlId}`,
    ]);
    const parentLock = await transaction.query(
      'SELECT id FROM source_crawls WHERE id::text = ? FOR UPDATE',
      [crawlId],
    );
    if (parentLock.rows.length !== 1) {
      throw new Error(`Source crawl ${crawlId} does not exist.`);
    }
    const binding = await transaction.query(
      'SELECT job_id AS "jobId" FROM source_crawls WHERE id::text = ?',
      [crawlId],
    );
    const jobId = exactBinding(binding.rows[0]?.jobId);
    await transaction.query(
      'LOCK TABLE _smrt_jobs IN SHARE ROW EXCLUSIVE MODE',
    );
    if (jobId) {
      await transaction.query(
        'SELECT id FROM _smrt_jobs WHERE id::text = ? FOR UPDATE',
        [jobId],
      );
    }
    await transaction.query(
      `SELECT id FROM source_crawl_items
       WHERE source_crawl_id = ? ORDER BY id::text FOR UPDATE`,
      [crawlId],
    );

    await ensureRepairAuditTables(transaction);
    const previous = await transaction.query(
      'SELECT summary FROM data_repair_runs WHERE repair_id = ? LIMIT 1',
      [repairId],
    );
    if (previous.rows.length > 0) {
      return jsonRecord(
        previous.rows[0]?.summary,
      ) as unknown as SourceCrawlParentRecoveryResult;
    }

    const rows = await selectRows(transaction, crawlId);
    const plan = planFromRows(crawlId, rows, now);
    if (plan.fingerprint !== input.expectedFingerprint) {
      throw new Error(
        `Source crawl parent recovery plan changed: expected ${input.expectedFingerprint}, found ${plan.fingerprint}. Inspect again before applying.`,
      );
    }
    if (!plan.eligible) {
      throw new Error(`Source crawl parent is not eligible: ${plan.reason}`);
    }

    const metadata = JSON.stringify({
      crawlId,
      planSha256: plan.fingerprint,
      recoveryReason: reason,
      terminalStatus: 'timed_out',
      version: SOURCE_CRAWL_PARENT_RECOVERY_VERSION,
    });
    await archiveBeforeRow(transaction, {
      action: 'recover_stale_legacy_parent',
      backupSha256: input.backupSha256,
      beforeData: rows.crawlBefore,
      metadata,
      repairId,
      rowId: crawlId,
      tableName: 'source_crawls',
    });
    if (rows.jobBefore) {
      await archiveBeforeRow(transaction, {
        action: 'recover_stale_legacy_parent_job',
        backupSha256: input.backupSha256,
        beforeData: rows.jobBefore,
        metadata,
        repairId,
        rowId: stringValue(rows.jobBefore.id),
        tableName: '_smrt_jobs',
      });
    }
    for (const item of rows.itemBefore) {
      await archiveBeforeRow(transaction, {
        action: 'recover_stale_legacy_parent_item',
        backupSha256: input.backupSha256,
        beforeData: item,
        metadata,
        repairId,
        rowId: stringValue(item.id),
        tableName: 'source_crawl_items',
      });
    }

    const accounting = await reconcileSourceCrawlAccountingTransaction(
      transaction,
      crawlId,
    );
    if (accounting.pendingCount !== 0) {
      throw new Error(
        `Source crawl ${crawlId} still has ${accounting.pendingCount} pending attempts.`,
      );
    }
    const message = `Timed out by ${SOURCE_CRAWL_PARENT_RECOVERY_VERSION}: ${reason}`;
    const updated = await transaction.query(
      `UPDATE source_crawls
       SET status = 'timed_out', error = ?, finished_at = ?, updated_at = ?
       WHERE id::text = ?
         AND status = 'running'
         AND finished_at IS NULL
         AND source_id = ?
         AND job_id = ?
         AND COALESCE(job_attempt, 0) = 0
       RETURNING id`,
      [message, now, now, crawlId, plan.sourceId, jobId],
    );
    if (updated.rows.length !== 1 && updated.rowCount !== 1) {
      throw new Error(
        `Source crawl ${crawlId} changed before its exact parent fence could be applied.`,
      );
    }
    const result: SourceCrawlParentRecoveryResult = {
      accounting,
      archivedRows: 1 + (rows.jobBefore ? 1 : 0) + rows.itemBefore.length,
      crawlId,
      fingerprint: plan.fingerprint,
      repairId,
      status: 'timed_out',
    };
    await transaction.query(
      `INSERT INTO data_repair_runs (
         repair_id, plan_sha256, backup_sha256, summary, completed_at
       ) VALUES (?, ?, ?, CAST(? AS jsonb), CURRENT_TIMESTAMP)`,
      [repairId, plan.fingerprint, input.backupSha256, JSON.stringify(result)],
    );
    return result;
  });
}

async function selectRows(
  db: Pick<SmrtDatabase, 'query'>,
  crawlId: string,
): Promise<ParentRecoveryRows> {
  const result = await db.query(
    `SELECT
       to_jsonb(crawl) AS "crawlBefore",
       EXTRACT(EPOCH FROM crawl.started_at) * 1000 AS "startedAtEpochMs",
       CASE WHEN job.id IS NULL THEN NULL ELSE to_jsonb(job) END AS "jobBefore",
       COALESCE((
         SELECT jsonb_agg(to_jsonb(item) ORDER BY item.id::text)
         FROM source_crawl_items AS item
         WHERE item.source_crawl_id = crawl.id::text
       ), '[]'::jsonb) AS "itemBefore"
     FROM source_crawls AS crawl
     LEFT JOIN _smrt_jobs AS job ON job.id::text = crawl.job_id
     WHERE crawl.id::text = ?`,
    [crawlId],
  );
  if (result.rows.length !== 1) {
    throw new Error(`Source crawl ${crawlId} does not exist.`);
  }
  const row = result.rows[0];
  return {
    crawlBefore: jsonRecord(row?.crawlBefore),
    itemBefore: jsonRecords(row?.itemBefore).sort((left, right) =>
      stringValue(left.id).localeCompare(stringValue(right.id)),
    ),
    jobBefore: row?.jobBefore == null ? null : jsonRecord(row.jobBefore),
    startedAtEpochMs: finiteNumber(row?.startedAtEpochMs),
  };
}

function planFromRows(
  crawlId: string,
  rows: ParentRecoveryRows,
  now: Date,
): SourceCrawlParentRecoveryPlan {
  const crawl = rows.crawlBefore;
  const sourceId = exactBinding(crawl.source_id);
  const jobId = exactBinding(crawl.job_id);
  const jobAttempt = Number(crawl.job_attempt ?? 0);
  let reason = '';
  if (crawl.status !== 'running')
    reason = 'parent status is not exactly running';
  else if (crawl.finished_at !== null)
    reason = 'parent finished_at is missing or already set';
  else if (!staleStartedAt(crawl.started_at, now, rows.startedAtEpochMs))
    reason =
      'parent has not exceeded the application timeout or started_at is malformed';
  else if (!Number.isInteger(jobAttempt) || jobAttempt !== 0)
    reason = 'parent job_attempt is not blank or zero';
  else if (!jobId) reason = 'parent job_id is not an exact nonblank binding';
  else if (!sourceId)
    reason = 'parent source_id is not an exact nonblank binding';
  else if (rows.itemBefore.some((item) => item.outcome === 'pending'))
    reason = 'at least one item outcome is pending';
  else if (rows.itemBefore.some((item) => item.terminal_at == null))
    reason = 'at least one item terminal_at is null';
  else if (rows.jobBefore)
    reason = jobIneligibility(rows.jobBefore, jobId, sourceId);

  const stable = {
    crawlBefore: rows.crawlBefore,
    crawlId,
    itemBefore: rows.itemBefore,
    jobBefore: rows.jobBefore,
    version: SOURCE_CRAWL_PARENT_RECOVERY_VERSION,
  };
  return {
    crawlId,
    eligible: !reason,
    fingerprint: createHash('sha256')
      .update(stableStringify(stable))
      .digest('hex'),
    itemCount: rows.itemBefore.length,
    jobPresent: rows.jobBefore !== null,
    reason:
      reason || 'stale legacy parent has no pending items or active owner',
    sourceId,
    version: SOURCE_CRAWL_PARENT_RECOVERY_VERSION,
  };
}

function jobIneligibility(
  job: Record<string, unknown>,
  jobId: string,
  sourceId: string,
): string {
  if (exactBinding(job.id) !== jobId) return 'referenced job id does not match';
  if (exactBinding(job.object_id) !== sourceId)
    return 'referenced job source binding does not match';
  if (job.status !== 'failed')
    return 'referenced job status is not exactly failed';
  if (job.queue !== SOURCE_CRAWL_QUEUE && job.queue !== SCHEDULED_SOURCE_QUEUE)
    return 'referenced job queue is not a source crawl queue';
  if (job.object_type !== SOURCE_JOB_OBJECT_TYPE)
    return 'referenced job object type does not match';
  if (job.method !== SOURCE_CRAWL_METHOD)
    return 'referenced job method does not match';
  return '';
}

function staleStartedAt(
  value: unknown,
  now: Date,
  epochMilliseconds?: number,
): boolean {
  if (epochMilliseconds !== undefined) {
    return epochMilliseconds <= now.getTime() - SOURCE_CRAWL_TIMEOUT_MS;
  }
  if (
    !(value instanceof Date) &&
    (typeof value !== 'string' || !value || value !== value.trim())
  )
    return false;
  const startedAt = value instanceof Date ? value : new Date(value);
  return (
    Number.isFinite(startedAt.getTime()) &&
    startedAt.getTime() <= now.getTime() - SOURCE_CRAWL_TIMEOUT_MS
  );
}

async function archiveBeforeRow(
  db: Pick<SmrtDatabase, 'query'>,
  input: {
    action: string;
    backupSha256: string;
    beforeData: Record<string, unknown>;
    metadata: string;
    repairId: string;
    rowId: string;
    tableName: string;
  },
): Promise<void> {
  await db.query(
    `INSERT INTO data_repair_audit (
       id, repair_id, table_name, row_id, action, before_data, metadata, backup_sha256
     ) VALUES (?, ?, ?, ?, ?, CAST(? AS jsonb), CAST(? AS jsonb), ?)
     ON CONFLICT (repair_id, table_name, row_id, action) DO NOTHING`,
    [
      randomUUID(),
      input.repairId,
      input.tableName,
      input.rowId,
      input.action,
      JSON.stringify(input.beforeData),
      input.metadata,
      input.backupSha256,
    ],
  );
}

async function ensureRepairAuditTables(
  db: Pick<SmrtDatabase, 'query'>,
): Promise<void> {
  await db.query(`CREATE TABLE IF NOT EXISTS data_repair_runs (
    repair_id TEXT PRIMARY KEY, plan_sha256 TEXT NOT NULL, backup_sha256 TEXT NOT NULL,
    summary JSONB NOT NULL, completed_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`);
  await db.query(`CREATE TABLE IF NOT EXISTS data_repair_audit (
    id TEXT PRIMARY KEY, repair_id TEXT NOT NULL REFERENCES data_repair_runs(repair_id)
      DEFERRABLE INITIALLY DEFERRED,
    table_name TEXT NOT NULL, row_id TEXT NOT NULL, action TEXT NOT NULL,
    before_data JSONB NOT NULL, metadata JSONB NOT NULL, backup_sha256 TEXT NOT NULL,
    archived_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (repair_id, table_name, row_id, action)
  )`);
}

function stableStringify(value: unknown): string {
  if (value instanceof Date) return JSON.stringify(value.toISOString());
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value && typeof value === 'object')
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`)
      .join(',')}}`;
  return JSON.stringify(value);
}

function exactId(value: unknown): string {
  const id = exactBinding(value);
  if (!id || id.length > 200)
    throw new Error('An exact non-empty source crawl id is required.');
  return id;
}

function exactBinding(value: unknown): string {
  return typeof value === 'string' &&
    value &&
    value.length <= 200 &&
    value === value.trim()
    ? value
    : '';
}

function finiteNumber(value: unknown): number | undefined {
  if (value === null || value === undefined || value === '') return undefined;
  const number = Number(value);
  return Number.isFinite(number) ? number : undefined;
}

function boundedReason(value: unknown): string {
  if (typeof value !== 'string' || !value || value !== value.trim())
    throw new Error('A non-empty recovery reason is required.');
  if (value.length > 500)
    throw new Error('The recovery reason must be at most 500 characters.');
  return value;
}

function validNow(value: Date | undefined): Date {
  const now = value ?? new Date();
  if (!(now instanceof Date) || !Number.isFinite(now.getTime()))
    throw new Error('A valid recovery clock is required.');
  return now;
}

function assertSha256(value: string, label: string): void {
  if (!/^[a-f0-9]{64}$/u.test(value))
    throw new Error(`A lowercase SHA-256 ${label} digest is required.`);
}

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function jsonRecord(value: unknown): Record<string, unknown> {
  if (value && typeof value === 'object' && !Array.isArray(value))
    return value as Record<string, unknown>;
  if (typeof value === 'string')
    return jsonRecord(JSON.parse(value) as unknown);
  return {};
}

function jsonRecords(value: unknown): Record<string, unknown>[] {
  if (typeof value === 'string')
    return jsonRecords(JSON.parse(value) as unknown);
  return Array.isArray(value) ? value.map(jsonRecord) : [];
}
