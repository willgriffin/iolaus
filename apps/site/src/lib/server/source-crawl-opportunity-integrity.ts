import { createHash, randomUUID } from 'node:crypto';
import type { resolveDatabase } from '@happyvertical/smrt-core';

type SmrtDatabase = Awaited<ReturnType<typeof resolveDatabase>>;

export const SOURCE_CRAWL_OPPORTUNITY_FOREIGN_KEY =
  'source_crawl_items_opportunity_id_fkey';
export const SOURCE_CRAWL_OPPORTUNITY_REPAIR_VERSION =
  '20260831_source_crawl_opportunity_orphans_v1';
export const SOURCE_CRAWL_OPPORTUNITY_REPAIR_MAX_BATCH = 500;

interface OrphanRow {
  beforeData: Record<string, unknown>;
  opportunityId: string;
  rowId: string;
}

export interface SourceCrawlOpportunityPlan {
  afterId: string;
  fingerprint: string;
  hasMore: boolean;
  limit: number;
  rows: OrphanRow[];
  totalDangling: number;
  version: typeof SOURCE_CRAWL_OPPORTUNITY_REPAIR_VERSION;
}

export interface SourceCrawlOpportunityGuardStatus {
  foreignKeyPresent: boolean;
  foreignKeyValidated: boolean;
  totalDangling: number;
}

export interface SourceCrawlOpportunityPlanAttestation {
  afterId: string;
  limit: number;
  planSha256: string;
}

export interface SourceCrawlOpportunityRepairResult {
  fingerprint: string;
  reconciledRows: number;
  repairId: string;
  remainingDangling: number;
}

/**
 * Normalize only the legacy empty sentinel before schema reconciliation.
 * Non-UUID-shaped values are not guessed or discarded: deployment stops for
 * explicit operator review.
 */
export async function prepareSourceCrawlOpportunityReference(
  db: SmrtDatabase,
): Promise<void> {
  if (!(await integrityTablesExist(db))) return;
  const column = await db.query(`
    SELECT data_type AS "dataType"
    FROM information_schema.columns
    WHERE table_schema = current_schema()
      AND table_name = 'source_crawl_items'
      AND column_name = 'opportunity_id'
  `);
  const dataType = stringValue(column.rows[0]?.dataType);
  if (dataType === 'uuid') return;
  if (dataType !== 'text' && dataType !== 'character varying') {
    throw new Error(
      `Unsupported source_crawl_items.opportunity_id type ${dataType || '<missing>'}.`,
    );
  }
  await db.query(`
    UPDATE source_crawl_items
    SET opportunity_id = NULL
    WHERE BTRIM(COALESCE(opportunity_id, '')) = ''
  `);
  const invalid = await db.query(`
    SELECT id::text AS id, opportunity_id
    FROM source_crawl_items
    WHERE opportunity_id IS NOT NULL
      AND opportunity_id !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    ORDER BY id
    LIMIT 1
  `);
  if (invalid.rows.length > 0) {
    throw new Error(
      `Source crawl item ${stringValue(invalid.rows[0]?.id)} has a non-UUID opportunity reference; inspect it before migration.`,
    );
  }
}

/**
 * Install the compatible text key as NOT VALID after SMRT owns the column type.
 * PostgreSQL enforces it for every new write and parent delete while allowing
 * the separately audited legacy repair to remain an explicit operator action.
 */
export async function ensureSourceCrawlOpportunityGuard(
  db: SmrtDatabase,
): Promise<SourceCrawlOpportunityGuardStatus> {
  if (!(await integrityTablesExist(db))) return emptyGuardStatus();
  await db.query(`
    ALTER TABLE opportunities
    ADD COLUMN IF NOT EXISTS _integrity_id_text TEXT
    GENERATED ALWAYS AS (id::text) STORED
  `);
  await db.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS opportunities_integrity_id_text_uidx
    ON opportunities (_integrity_id_text)
  `);
  if (!(await sourceCrawlOpportunityConstraintExists(db))) {
    await db.query(`
      ALTER TABLE source_crawl_items
      ADD CONSTRAINT ${SOURCE_CRAWL_OPPORTUNITY_FOREIGN_KEY}
      FOREIGN KEY (opportunity_id)
      REFERENCES opportunities (_integrity_id_text)
      ON UPDATE CASCADE ON DELETE RESTRICT
      NOT VALID
    `);
  }
  return await getSourceCrawlOpportunityGuardStatus(db);
}

export async function validateSourceCrawlOpportunityGuard(
  db: SmrtDatabase,
): Promise<SourceCrawlOpportunityGuardStatus> {
  const status = await getSourceCrawlOpportunityGuardStatus(db);
  if (!status.foreignKeyPresent) {
    throw new Error('Source crawl opportunity foreign key is missing.');
  }
  if (status.totalDangling > 0) {
    throw new Error(
      `Cannot validate source crawl opportunity foreign key with ${status.totalDangling} dangling references.`,
    );
  }
  if (!status.foreignKeyValidated) {
    await db.query(`
      ALTER TABLE source_crawl_items
      VALIDATE CONSTRAINT ${SOURCE_CRAWL_OPPORTUNITY_FOREIGN_KEY}
    `);
  }
  return await getSourceCrawlOpportunityGuardStatus(db);
}

export async function getSourceCrawlOpportunityGuardStatus(
  db: SmrtDatabase,
): Promise<SourceCrawlOpportunityGuardStatus> {
  if (!(await integrityTablesExist(db))) return emptyGuardStatus();
  const constraint = await db.query(
    `SELECT convalidated
     FROM pg_constraint
     WHERE conrelid = 'source_crawl_items'::regclass
       AND conname = ?`,
    [SOURCE_CRAWL_OPPORTUNITY_FOREIGN_KEY],
  );
  const count = await db.query(`
    SELECT COUNT(*)::integer AS count
    FROM source_crawl_items AS item
    LEFT JOIN opportunities AS opportunity
      ON opportunity.id::text = item.opportunity_id
    WHERE NULLIF(BTRIM(item.opportunity_id), '') IS NOT NULL
      AND opportunity.id IS NULL
  `);
  return {
    foreignKeyPresent: constraint.rows.length === 1,
    foreignKeyValidated: constraint.rows[0]?.convalidated === true,
    totalDangling: Number(count.rows[0]?.count ?? 0),
  };
}

export async function inspectSourceCrawlOpportunityOrphans(
  db: SmrtDatabase,
  options: { afterId?: string; limit?: number } = {},
): Promise<SourceCrawlOpportunityPlan> {
  const afterId = stringValue(options.afterId);
  const limit = boundedBatchSize(options.limit);
  if (!(await integrityTablesExist(db))) {
    return planFromRows([], {
      afterId,
      hasMore: false,
      limit,
      totalDangling: 0,
    });
  }
  // Keep these sequential: repair applies on a pinned transaction session,
  // whose PostgreSQL adapter intentionally permits one in-flight query.
  const count = await db.query(`
      SELECT COUNT(*)::integer AS count
      FROM source_crawl_items AS item
      LEFT JOIN opportunities AS opportunity
        ON opportunity.id::text = item.opportunity_id
      WHERE NULLIF(BTRIM(item.opportunity_id), '') IS NOT NULL
        AND opportunity.id IS NULL
    `);
  const cursorSql = afterId ? 'AND item.id::text > ?' : '';
  const rows = await db.query(
    `SELECT
         item.id::text AS "rowId",
         item.opportunity_id AS "opportunityId",
         to_jsonb(item) AS "beforeData"
       FROM source_crawl_items AS item
       LEFT JOIN opportunities AS opportunity
         ON opportunity.id::text = item.opportunity_id
       WHERE NULLIF(BTRIM(item.opportunity_id), '') IS NOT NULL
         AND opportunity.id IS NULL
         ${cursorSql}
       ORDER BY item.id::text
       LIMIT ?`,
    afterId ? [afterId, limit + 1] : [limit + 1],
  );
  const selected = rows.rows.slice(0, limit).map((row) => ({
    beforeData: jsonRecord(row.beforeData),
    opportunityId: stringValue(row.opportunityId),
    rowId: stringValue(row.rowId),
  }));
  return planFromRows(selected, {
    afterId,
    hasMore: rows.rows.length > limit,
    limit,
    totalDangling: Number(count.rows[0]?.count ?? 0),
  });
}

export async function inspectSourceCrawlOpportunityPlanAttestations(
  db: SmrtDatabase,
  options: { limit?: number } = {},
): Promise<SourceCrawlOpportunityPlanAttestation[]> {
  const attestations: SourceCrawlOpportunityPlanAttestation[] = [];
  let afterId = '';
  let hasMore = true;
  while (hasMore) {
    const plan = await inspectSourceCrawlOpportunityOrphans(db, {
      afterId,
      limit: options.limit,
    });
    attestations.push({
      afterId,
      limit: plan.limit,
      planSha256: plan.fingerprint,
    });
    hasMore = plan.hasMore;
    if (!hasMore) break;
    const nextAfterId = plan.rows.at(-1)?.rowId ?? '';
    if (!nextAfterId || nextAfterId === afterId) {
      throw new Error('Source crawl recovery plan cursor did not advance.');
    }
    afterId = nextAfterId;
  }
  return attestations;
}

export async function applySourceCrawlOpportunityRepair(
  db: SmrtDatabase,
  options: {
    afterId?: string;
    backupSha256: string;
    expectedFingerprint: string;
    limit?: number;
  },
): Promise<SourceCrawlOpportunityRepairResult> {
  assertSha256(options.backupSha256, 'backup');
  assertSha256(options.expectedFingerprint, 'plan');
  if (typeof db.transaction !== 'function') {
    throw new Error('Source crawl opportunity repair requires a transaction.');
  }
  const repairId = repairIdForFingerprint(options.expectedFingerprint);

  return await db.transaction(async (transaction) => {
    await transaction.query("SET LOCAL lock_timeout = '15s'");
    await transaction.query('SELECT pg_advisory_xact_lock(hashtext(?))', [
      SOURCE_CRAWL_OPPORTUNITY_REPAIR_VERSION,
    ]);
    await transaction.query(
      'LOCK TABLE opportunities, source_crawl_items IN SHARE ROW EXCLUSIVE MODE',
    );
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
      ) as unknown as SourceCrawlOpportunityRepairResult;
    }

    const plan = await inspectSourceCrawlOpportunityOrphans(transaction, {
      afterId: options.afterId,
      limit: options.limit,
    });
    if (plan.fingerprint !== options.expectedFingerprint) {
      throw new Error(
        `Source crawl opportunity plan changed: expected ${options.expectedFingerprint}, found ${plan.fingerprint}. Inspect again before applying.`,
      );
    }

    for (const row of plan.rows) {
      await transaction.query(
        `INSERT INTO data_repair_audit (
           id, repair_id, table_name, row_id, action, before_data, metadata,
           backup_sha256
         ) VALUES (?, ?, 'source_crawl_items', ?, 'clear_orphan_opportunity',
                   CAST(? AS jsonb), CAST(? AS jsonb), ?)
         ON CONFLICT (repair_id, table_name, row_id, action) DO NOTHING`,
        [
          randomUUID(),
          repairId,
          row.rowId,
          JSON.stringify(row.beforeData),
          JSON.stringify({ missingOpportunityId: row.opportunityId }),
          options.backupSha256,
        ],
      );
      const note = `Missing opportunity ${row.opportunityId} cleared by ${SOURCE_CRAWL_OPPORTUNITY_REPAIR_VERSION}.`;
      const updated = await transaction.query(
        `UPDATE source_crawl_items
         SET opportunity_id = NULL,
             reconciliation_status = 'error',
             status = 'persistence_error',
             reason = CASE
               WHEN BTRIM(COALESCE(reason, '')) = '' THEN ?
               ELSE reason || E'\\n' || ?
             END,
             reconciliation_notes = CASE
               WHEN BTRIM(COALESCE(reconciliation_notes, '')) = '' THEN ?
               ELSE reconciliation_notes || E'\\n' || ?
             END,
             updated_at = CURRENT_TIMESTAMP
         WHERE id::text = ?
           AND opportunity_id = ?`,
        [note, note, note, note, row.rowId, row.opportunityId],
      );
      if (updated.rowCount !== 1) {
        throw new Error(
          `Expected to reconcile source crawl item ${row.rowId}; updated ${updated.rowCount ?? 0}.`,
        );
      }
    }

    const remaining = await getSourceCrawlOpportunityGuardStatus(transaction);
    const result: SourceCrawlOpportunityRepairResult = {
      fingerprint: plan.fingerprint,
      reconciledRows: plan.rows.length,
      repairId,
      remainingDangling: remaining.totalDangling,
    };
    await transaction.query(
      `INSERT INTO data_repair_runs (
         repair_id, plan_sha256, backup_sha256, summary, completed_at
       ) VALUES (?, ?, ?, CAST(? AS jsonb), CURRENT_TIMESTAMP)`,
      [
        repairId,
        plan.fingerprint,
        options.backupSha256,
        JSON.stringify(result),
      ],
    );
    if (remaining.totalDangling === 0) {
      await validateSourceCrawlOpportunityGuard(transaction);
    }
    return result;
  });
}

/**
 * The only supported destructive dedupe path. Both rows are locked, every
 * crawl provenance reference is retargeted, and the alias deletion happens in
 * the caller's transaction. Any failure rolls the retargeting back with it.
 */
export async function mergeOpportunityCrawlReferences(
  db: SmrtDatabase,
  options: {
    aliasId: string;
    deleteAlias: () => Promise<boolean>;
    survivorId: string;
  },
): Promise<number> {
  const aliasId = requiredId(options.aliasId, 'alias');
  const survivorId = requiredId(options.survivorId, 'survivor');
  if (aliasId === survivorId) {
    throw new Error('Opportunity alias and survivor must be different rows.');
  }
  const locked = await db.query(
    `SELECT id::text AS id
     FROM opportunities
     WHERE id::text IN (?, ?)
     ORDER BY id::text
     FOR UPDATE`,
    [aliasId, survivorId],
  );
  const ids = new Set(locked.rows.map((row) => stringValue(row.id)));
  if (!ids.has(aliasId) || !ids.has(survivorId)) {
    throw new Error('Opportunity merge requires both alias and survivor rows.');
  }
  const retargeted = await db.query(
    `UPDATE source_crawl_items
     SET opportunity_id = ?, updated_at = CURRENT_TIMESTAMP
     WHERE opportunity_id = ?`,
    [survivorId, aliasId],
  );
  if (!(await options.deleteAlias())) {
    throw new Error('Could not delete the duplicate opportunity alias.');
  }
  const remaining = await db.query(
    `SELECT COUNT(*)::integer AS count
     FROM source_crawl_items
     WHERE opportunity_id = ?`,
    [aliasId],
  );
  if (Number(remaining.rows[0]?.count ?? 0) !== 0) {
    throw new Error('Opportunity merge left crawl references on the alias.');
  }
  return retargeted.rowCount ?? 0;
}

function planFromRows(
  rows: OrphanRow[],
  options: {
    afterId: string;
    hasMore: boolean;
    limit: number;
    totalDangling: number;
  },
): SourceCrawlOpportunityPlan {
  const stable = {
    afterId: options.afterId,
    limit: options.limit,
    rows: rows.map(({ beforeData, opportunityId, rowId }) => ({
      beforeData,
      opportunityId,
      rowId,
    })),
    version: SOURCE_CRAWL_OPPORTUNITY_REPAIR_VERSION,
  };
  return {
    ...options,
    fingerprint: createHash('sha256')
      .update(stableStringify(stable))
      .digest('hex'),
    rows,
    version: SOURCE_CRAWL_OPPORTUNITY_REPAIR_VERSION,
  };
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

async function integrityTablesExist(db: SmrtDatabase): Promise<boolean> {
  const result = await db.query(`
    SELECT
      to_regclass('source_crawl_items') IS NOT NULL AS "itemsExist",
      to_regclass('opportunities') IS NOT NULL AS "opportunitiesExist"
  `);
  return (
    result.rows[0]?.itemsExist === true &&
    result.rows[0]?.opportunitiesExist === true
  );
}

async function sourceCrawlOpportunityConstraintExists(
  db: SmrtDatabase,
): Promise<boolean> {
  const result = await db.query(
    `SELECT 1
     FROM pg_constraint
     WHERE conrelid = 'source_crawl_items'::regclass
       AND conname = ?
     LIMIT 1`,
    [SOURCE_CRAWL_OPPORTUNITY_FOREIGN_KEY],
  );
  return result.rows.length > 0;
}

async function ensureRepairAuditTables(db: SmrtDatabase): Promise<void> {
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

function boundedBatchSize(value: number | undefined): number {
  const limit = value ?? 100;
  if (
    !Number.isInteger(limit) ||
    limit < 1 ||
    limit > SOURCE_CRAWL_OPPORTUNITY_REPAIR_MAX_BATCH
  ) {
    throw new Error(
      `Repair batch size must be from 1 to ${SOURCE_CRAWL_OPPORTUNITY_REPAIR_MAX_BATCH}.`,
    );
  }
  return limit;
}

function repairIdForFingerprint(fingerprint: string): string {
  return `${SOURCE_CRAWL_OPPORTUNITY_REPAIR_VERSION}:${fingerprint}`;
}

function requiredId(value: unknown, label: string): string {
  const id = stringValue(value);
  if (!id) throw new Error(`Opportunity ${label} id is required.`);
  return id;
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

function emptyGuardStatus(): SourceCrawlOpportunityGuardStatus {
  return {
    foreignKeyPresent: false,
    foreignKeyValidated: false,
    totalDangling: 0,
  };
}
