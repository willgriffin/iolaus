import { createHash, randomUUID } from 'node:crypto';
import type { resolveDatabase } from '@happyvertical/smrt-core';
import {
  reconcileSourceCrawlAccountingTransaction,
  type SourceCrawlAccounting,
} from './source-crawl-accounting.js';
import { SOURCE_CRAWL_TIMEOUT_MS } from './source-schedules.js';

type SmrtDatabase = Awaited<ReturnType<typeof resolveDatabase>>;

export const SOURCE_CRAWL_ITEM_QUARANTINE_VERSION =
  '20260831_source_crawl_item_quarantine_v1';

interface QuarantineRows {
  crawlBefore: Record<string, unknown>;
  itemBefore: Record<string, unknown>;
  startedAtEpochMs?: number;
}

export interface SourceCrawlItemQuarantinePlan {
  crawlId: string;
  eligible: boolean;
  fingerprint: string;
  itemId: string;
  itemOutcome: string;
  itemStatus: string;
  reason: string;
  version: typeof SOURCE_CRAWL_ITEM_QUARANTINE_VERSION;
}

export interface SourceCrawlItemQuarantineResult {
  accounting: SourceCrawlAccounting;
  crawlId: string;
  fingerprint: string;
  itemId: string;
  quarantinedRows: number;
  repairId: string;
}

/** Build a read-only, exact-row quarantine plan. */
export async function inspectSourceCrawlItemQuarantine(
  db: SmrtDatabase,
  input: { crawlId: string; itemId: string; now?: Date },
): Promise<SourceCrawlItemQuarantinePlan> {
  const crawlId = exactId(input.crawlId, 'crawl');
  const itemId = exactId(input.itemId, 'item');
  const now = validNow(input.now);
  const rows = await selectRows(db, crawlId, itemId);
  return planFromRows(crawlId, itemId, rows, now);
}

/**
 * Quarantine one operator-selected ambiguous pending item. The full before
 * state is archived, but no Opportunity identity or success outcome is
 * inferred.
 */
export async function applySourceCrawlItemQuarantine(
  db: SmrtDatabase,
  input: {
    backupSha256: string;
    crawlId: string;
    expectedFingerprint: string;
    itemId: string;
    now?: Date;
    reason: string;
  },
): Promise<SourceCrawlItemQuarantineResult> {
  const crawlId = exactId(input.crawlId, 'crawl');
  const itemId = exactId(input.itemId, 'item');
  const now = validNow(input.now);
  const reason = boundedReason(input.reason);
  assertSha256(input.backupSha256, 'backup');
  assertSha256(input.expectedFingerprint, 'plan');
  if (typeof db.transaction !== 'function') {
    throw new Error('Source crawl item quarantine requires a transaction.');
  }
  const repairId = repairIdForFingerprint(input.expectedFingerprint);

  return await db.transaction(async (transaction) => {
    await transaction.query("SET LOCAL lock_timeout = '15s'");
    await transaction.query('SELECT pg_advisory_xact_lock(hashtext(?))', [
      `${SOURCE_CRAWL_ITEM_QUARANTINE_VERSION}:${crawlId}:${itemId}`,
    ]);
    const crawlLock = await transaction.query(
      'SELECT id FROM source_crawls WHERE id::text = ? FOR UPDATE',
      [crawlId],
    );
    if (crawlLock.rows.length !== 1) {
      throw new Error(`Source crawl ${crawlId} does not exist.`);
    }
    const itemLock = await transaction.query(
      `SELECT id
       FROM source_crawl_items
       WHERE id::text = ? AND source_crawl_id = ?
       FOR UPDATE`,
      [itemId, crawlId],
    );
    if (itemLock.rows.length !== 1) {
      throw new Error(
        `Source crawl item ${itemId} does not belong to crawl ${crawlId}.`,
      );
    }

    await ensureRepairAuditTables(transaction);
    const previous = await transaction.query(
      `SELECT summary
       FROM data_repair_runs
       WHERE repair_id = ?
       LIMIT 1`,
      [repairId],
    );
    if (previous.rows.length > 0) {
      return jsonRecord(
        previous.rows[0]?.summary,
      ) as unknown as SourceCrawlItemQuarantineResult;
    }

    const rows = await selectRows(transaction, crawlId, itemId);
    const plan = planFromRows(crawlId, itemId, rows, now);
    if (plan.fingerprint !== input.expectedFingerprint) {
      throw new Error(
        `Source crawl item quarantine plan changed: expected ${input.expectedFingerprint}, found ${plan.fingerprint}. Inspect again before applying.`,
      );
    }
    if (!plan.eligible) {
      throw new Error(`Source crawl item is not eligible: ${plan.reason}`);
    }

    const metadata = JSON.stringify({
      crawlId,
      itemId,
      planSha256: plan.fingerprint,
      quarantineReason: reason,
      terminalOutcome: 'failed_persistence',
      version: SOURCE_CRAWL_ITEM_QUARANTINE_VERSION,
    });
    await archiveBeforeRow(transaction, {
      action: 'quarantine_ambiguous_item_parent',
      backupSha256: input.backupSha256,
      beforeData: rows.crawlBefore,
      metadata,
      repairId,
      rowId: crawlId,
      tableName: 'source_crawls',
    });
    await archiveBeforeRow(transaction, {
      action: 'quarantine_ambiguous_item',
      backupSha256: input.backupSha256,
      beforeData: rows.itemBefore,
      metadata,
      repairId,
      rowId: itemId,
      tableName: 'source_crawl_items',
    });

    const note = `Quarantined by ${SOURCE_CRAWL_ITEM_QUARANTINE_VERSION}: ${reason}`;
    const updated = await transaction.query(
      `UPDATE source_crawl_items
       SET outcome = 'failed_persistence',
           opportunity_id = NULL,
           duplicate_of_source_crawl_item_id = '',
           status = 'persistence_error',
           reconciliation_status = 'error',
           reason = ?,
           reconciliation_notes = ?,
           terminal_at = CURRENT_TIMESTAMP,
           updated_at = CURRENT_TIMESTAMP
       WHERE id::text = ?
         AND source_crawl_id = ?
         AND outcome = 'pending'
         AND terminal_at IS NULL
         AND NULLIF(BTRIM(opportunity_id), '') IS NULL`,
      [note, note, itemId, crawlId],
    );
    if (updated.rowCount !== 1) {
      throw new Error(
        `Expected to quarantine source crawl item ${itemId}; updated ${updated.rowCount ?? 0}.`,
      );
    }

    const accounting = await reconcileSourceCrawlAccountingTransaction(
      transaction,
      crawlId,
    );
    const result: SourceCrawlItemQuarantineResult = {
      accounting,
      crawlId,
      fingerprint: plan.fingerprint,
      itemId,
      quarantinedRows: 1,
      repairId,
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
  itemId: string,
): Promise<QuarantineRows> {
  const result = await db.query(
    `SELECT
       to_jsonb(crawl) AS "crawlBefore",
       EXTRACT(EPOCH FROM crawl.started_at) * 1000 AS "startedAtEpochMs",
       to_jsonb(item) AS "itemBefore"
     FROM source_crawls AS crawl
     JOIN source_crawl_items AS item
       ON item.source_crawl_id = crawl.id::text
     WHERE crawl.id::text = ? AND item.id::text = ?`,
    [crawlId, itemId],
  );
  if (result.rows.length !== 1) {
    throw new Error(
      `Source crawl item ${itemId} does not belong to crawl ${crawlId}.`,
    );
  }
  return {
    crawlBefore: jsonRecord(result.rows[0]?.crawlBefore),
    itemBefore: jsonRecord(result.rows[0]?.itemBefore),
    startedAtEpochMs: finiteNumber(result.rows[0]?.startedAtEpochMs),
  };
}

function planFromRows(
  crawlId: string,
  itemId: string,
  rows: QuarantineRows,
  now: Date,
): SourceCrawlItemQuarantinePlan {
  const outcome = stringValue(rows.itemBefore.outcome);
  const status = stringValue(rows.itemBefore.status);
  const terminalAt = rows.itemBefore.terminal_at;
  const opportunityId = stringValue(rows.itemBefore.opportunity_id);
  const parentReason = staleParentIneligibility(
    rows.crawlBefore,
    now,
    rows.startedAtEpochMs,
  );
  const ineligibleReason = parentReason
    ? parentReason
    : outcome !== 'pending'
      ? `outcome is ${boundedDisplay(outcome) || '<empty>'}, not pending`
      : terminalAt !== null && terminalAt !== undefined
        ? 'terminal_at is already set'
        : opportunityId
          ? 'an Opportunity is already attributed'
          : hasRecoverableIntent(status)
            ? 'status contains a recoverable terminal intent'
            : '';
  const stable = {
    crawlBefore: rows.crawlBefore,
    crawlId,
    itemBefore: rows.itemBefore,
    itemId,
    version: SOURCE_CRAWL_ITEM_QUARANTINE_VERSION,
  };
  return {
    crawlId,
    eligible: !ineligibleReason,
    fingerprint: createHash('sha256')
      .update(stableStringify(stable))
      .digest('hex'),
    itemId,
    itemOutcome: boundedDisplay(outcome),
    itemStatus: boundedDisplay(status),
    reason:
      ineligibleReason || 'pending item has no recoverable terminal intent',
    version: SOURCE_CRAWL_ITEM_QUARANTINE_VERSION,
  };
}

function hasRecoverableIntent(status: string): boolean {
  return /^(?:pending_(?:created|relisted|reused):[^\s]+|pending_(?:duplicate|skipped):.+)$/u.test(
    status,
  );
}

function staleParentIneligibility(
  crawl: Record<string, unknown>,
  now: Date,
  startedAtEpochMs: number | undefined,
): string {
  if (crawl.status !== 'running') {
    return 'parent crawl status is not exactly running';
  }
  if (crawl.finished_at !== null) {
    return 'parent crawl finished_at is missing or already set';
  }
  if (startedAtEpochMs === undefined) {
    return 'parent crawl started_at is missing or malformed';
  }
  if (startedAtEpochMs > now.getTime() - SOURCE_CRAWL_TIMEOUT_MS) {
    return 'parent crawl has not exceeded the application timeout';
  }
  return '';
}

function finiteNumber(value: unknown): number | undefined {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : undefined;
  }
  if (typeof value !== 'string' || !value || value !== value.trim()) {
    return undefined;
  }
  const number = Number(value);
  return Number.isFinite(number) ? number : undefined;
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
       id, repair_id, table_name, row_id, action, before_data, metadata,
       backup_sha256
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
  await db.query(`
    CREATE TABLE IF NOT EXISTS data_repair_runs (
      repair_id TEXT PRIMARY KEY,
      plan_sha256 TEXT NOT NULL,
      backup_sha256 TEXT NOT NULL,
      summary JSONB NOT NULL,
      completed_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `);
  await db.query(`
    CREATE TABLE IF NOT EXISTS data_repair_audit (
      id TEXT PRIMARY KEY,
      repair_id TEXT NOT NULL REFERENCES data_repair_runs(repair_id)
        DEFERRABLE INITIALLY DEFERRED,
      table_name TEXT NOT NULL,
      row_id TEXT NOT NULL,
      action TEXT NOT NULL,
      before_data JSONB NOT NULL,
      metadata JSONB NOT NULL,
      backup_sha256 TEXT NOT NULL,
      archived_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE (repair_id, table_name, row_id, action)
    )
  `);
}

function stableStringify(value: unknown): string {
  if (value instanceof Date) return JSON.stringify(value.toISOString());
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

function repairIdForFingerprint(fingerprint: string): string {
  return `${SOURCE_CRAWL_ITEM_QUARANTINE_VERSION}:${fingerprint}`;
}

function exactId(value: unknown, label: string): string {
  if (
    typeof value !== 'string' ||
    !value ||
    value !== value.trim() ||
    value.length > 200
  ) {
    throw new Error(`An exact non-empty source crawl ${label} id is required.`);
  }
  return value;
}

function boundedDisplay(value: string): string {
  return value.length <= 200 ? value : `${value.slice(0, 197)}...`;
}

function boundedReason(value: unknown): string {
  if (typeof value !== 'string' || value !== value.trim() || !value) {
    throw new Error('A non-empty quarantine reason is required.');
  }
  if (value.length > 500) {
    throw new Error('The quarantine reason must be at most 500 characters.');
  }
  return value;
}

function validNow(value: Date | undefined): Date {
  const now = value ?? new Date();
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) {
    throw new Error('A valid quarantine clock is required.');
  }
  return now;
}

function assertSha256(value: string, label: string): void {
  if (!/^[a-f0-9]{64}$/u.test(value)) {
    throw new Error(`A lowercase SHA-256 ${label} digest is required.`);
  }
}

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function jsonRecord(value: unknown): Record<string, unknown> {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  if (typeof value === 'string') {
    const parsed = JSON.parse(value) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  }
  return {};
}
