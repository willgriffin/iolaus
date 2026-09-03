import { randomUUID } from 'node:crypto';
import type { resolveDatabase } from '@happyvertical/smrt-core';

type SmrtDatabase = Awaited<ReturnType<typeof resolveDatabase>>;
type QueryableDatabase = Pick<SmrtDatabase, 'query'>;

export const SOURCE_CRAWL_ATTEMPT_INDEX =
  'source_crawl_items_source_crawl_attempt_uidx';
export const SOURCE_CRAWL_OUTCOME_CONSTRAINT =
  'source_crawl_items_outcome_check';
export const SOURCE_CRAWL_OUTCOME_REFERENCE_CONSTRAINT =
  'source_crawl_items_outcome_reference_check';

export const SOURCE_CRAWL_TERMINAL_OUTCOMES = [
  'created',
  'reused',
  'relisted',
  'duplicate',
  'skipped',
  'failed_persistence',
] as const;

export type SourceCrawlTerminalOutcome =
  (typeof SOURCE_CRAWL_TERMINAL_OUTCOMES)[number];

export interface SourceCrawlAttemptRecord {
  attemptKey: string;
  duplicateOfSourceCrawlItemId: string;
  id: string;
  opportunityId: string | null;
  outcome: 'pending' | SourceCrawlTerminalOutcome;
  reason: string;
  sourceCrawlId: string;
  status: string;
  terminalAt: Date | string | null;
}

export interface CreateSourceCrawlAttemptInput {
  attemptKey: string;
  canonicalUrl?: string;
  companyName?: string;
  contentFingerprint?: string;
  contentVersion?: number;
  externalId?: string;
  postingUrl?: string;
  rawJson?: string;
  sourceCrawlId: string;
  title?: string;
}

export type PrepareSourceCrawlAttemptInput = CreateSourceCrawlAttemptInput;

export type SourceCrawlPersistenceIntent = 'created' | 'relisted' | 'reused';
export type SourceCrawlNonPersistenceIntent = 'duplicate' | 'skipped';

export interface FinalizeSourceCrawlAttemptInput {
  attemptKey: string;
  canonicalUrl?: string;
  companyName?: string;
  contentFingerprint?: string;
  contentVersion?: number;
  duplicateOfSourceCrawlItemId?: string;
  externalId?: string;
  opportunityId?: string | null;
  outcome: SourceCrawlTerminalOutcome;
  postingUrl?: string;
  rawJson?: string;
  reason?: string;
  sourceCrawlId: string;
  status?: string;
  title?: string;
}

export interface PersistCreatedSourceCrawlAttemptInput
  extends Omit<FinalizeSourceCrawlAttemptInput, 'outcome'> {
  opportunityId: string;
}

export interface SourceCrawlAccounting {
  attemptCount: number;
  createdCount: number;
  duplicateCount: number;
  failedPersistenceCount: number;
  pendingCount: number;
  relistedCount: number;
  reusedCount: number;
  skippedCount: number;
  terminalCount: number;
}

export interface SourceCrawlAccountingSchemaStatus {
  attemptIndexPresent: boolean;
  outcomeConstraintPresent: boolean;
  requiredColumnsPresent: number;
  requiredColumnsTotal: number;
}

const REQUIRED_ACCOUNTING_COLUMNS = [
  'attempt_key',
  'outcome',
  'terminal_at',
] as const;

/**
 * Add the database-level natural key and outcome guard after SMRT has added
 * the modeled columns. Empty legacy attempt keys remain outside the index.
 */
export async function ensureSourceCrawlAccountingSchema(
  db: SmrtDatabase,
): Promise<SourceCrawlAccountingSchemaStatus> {
  if (!(await accountingTablesExist(db))) return emptySchemaStatus();
  await db.query(`
    ALTER TABLE source_crawl_items
    ALTER COLUMN outcome SET DEFAULT 'pending'
  `);
  await db.query(`
    UPDATE source_crawl_items
    SET outcome = 'pending',
        updated_at = CURRENT_TIMESTAMP
    WHERE outcome IS NULL
  `);
  await db.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS ${SOURCE_CRAWL_ATTEMPT_INDEX}
    ON source_crawl_items (source_crawl_id, attempt_key)
    WHERE NULLIF(BTRIM(attempt_key), '') IS NOT NULL
  `);
  await db.query(`
    ALTER TABLE source_crawl_items
    DROP CONSTRAINT IF EXISTS ${SOURCE_CRAWL_OUTCOME_CONSTRAINT}
  `);
  await db.query(`
    ALTER TABLE source_crawl_items
    ADD CONSTRAINT ${SOURCE_CRAWL_OUTCOME_CONSTRAINT}
    CHECK (
      outcome IS NOT NULL AND outcome IN (
        'pending', 'created', 'reused', 'relisted', 'duplicate',
        'skipped', 'failed_persistence'
      )
    )
    NOT VALID
  `);
  await db.query(`
    ALTER TABLE source_crawl_items
    VALIDATE CONSTRAINT ${SOURCE_CRAWL_OUTCOME_CONSTRAINT}
  `);
  await db.query(`
    ALTER TABLE source_crawl_items
    DROP CONSTRAINT IF EXISTS ${SOURCE_CRAWL_OUTCOME_REFERENCE_CONSTRAINT}
  `);
  await db.query(`
    ALTER TABLE source_crawl_items
    ADD CONSTRAINT ${SOURCE_CRAWL_OUTCOME_REFERENCE_CONSTRAINT}
    CHECK (
      (outcome <> 'created' OR NULLIF(BTRIM(opportunity_id), '') IS NOT NULL)
      AND
      (outcome <> 'failed_persistence' OR NULLIF(BTRIM(opportunity_id), '') IS NULL)
    )
    NOT VALID
  `);
  await db.query(`
    ALTER TABLE source_crawl_items
    VALIDATE CONSTRAINT ${SOURCE_CRAWL_OUTCOME_REFERENCE_CONSTRAINT}
  `);
  return await getSourceCrawlAccountingSchemaStatus(db);
}

export async function getSourceCrawlAccountingSchemaStatus(
  db: QueryableDatabase,
): Promise<SourceCrawlAccountingSchemaStatus> {
  if (!(await accountingTablesExist(db))) return emptySchemaStatus();
  const columns = await db.query(
    `SELECT column_name AS "columnName"
     FROM information_schema.columns
     WHERE table_schema = current_schema()
       AND table_name = 'source_crawl_items'
       AND column_name IN (?, ?, ?)`,
    [...REQUIRED_ACCOUNTING_COLUMNS],
  );
  const index = await db.query(
    `SELECT 1
     FROM pg_indexes
     WHERE schemaname = current_schema()
       AND tablename = 'source_crawl_items'
       AND indexname = ?`,
    [SOURCE_CRAWL_ATTEMPT_INDEX],
  );
  const constraint = await db.query(
    `SELECT 1
     FROM pg_constraint
     WHERE conrelid = 'source_crawl_items'::regclass
       AND conname IN (?, ?)
       AND convalidated`,
    [
      SOURCE_CRAWL_OUTCOME_CONSTRAINT,
      SOURCE_CRAWL_OUTCOME_REFERENCE_CONSTRAINT,
    ],
  );
  return {
    attemptIndexPresent: index.rows.length === 1,
    outcomeConstraintPresent: constraint.rows.length === 2,
    requiredColumnsPresent: columns.rows.length,
    requiredColumnsTotal: REQUIRED_ACCOUNTING_COLUMNS.length,
  };
}

/** Create exactly one durable pending row for a provider candidate attempt. */
export async function createSourceCrawlAttempt(
  db: SmrtDatabase,
  input: CreateSourceCrawlAttemptInput,
): Promise<SourceCrawlAttemptRecord> {
  const sourceCrawlId = requiredText(input.sourceCrawlId, 'sourceCrawlId');
  const attemptKey = requiredText(input.attemptKey, 'attemptKey');
  if (typeof db.transaction !== 'function') {
    throw new Error('Source crawl accounting requires database transactions.');
  }
  const id = randomUUID();
  return await db.transaction(async (transaction) => {
    await lockRunningSourceCrawl(transaction, sourceCrawlId);
    const result = await transaction.query(
      `INSERT INTO source_crawl_items (
       id, slug, context, source_crawl_id, attempt_key, outcome, terminal_at,
       external_id, posting_url, canonical_url, title, company_name,
       status, content_fingerprint, content_version,
       intelligence_enqueue_status, reason, raw_json
     ) VALUES (
       ?, ?, '', ?, ?, 'pending', NULL,
       ?, ?, ?, ?, ?, 'pending', ?, ?, 'ineligible', '', ?
     )
     ON CONFLICT (source_crawl_id, attempt_key)
       WHERE NULLIF(BTRIM(attempt_key), '') IS NOT NULL
     DO UPDATE SET source_crawl_id = EXCLUDED.source_crawl_id
     RETURNING
       id::text AS id,
       source_crawl_id AS "sourceCrawlId",
       attempt_key AS "attemptKey",
       outcome,
       opportunity_id AS "opportunityId",
       COALESCE(duplicate_of_source_crawl_item_id, '') AS "duplicateOfSourceCrawlItemId",
       COALESCE(status, '') AS status,
       COALESCE(reason, '') AS reason,
       terminal_at AS "terminalAt"`,
      [
        id,
        `crawl-attempt-${id}`,
        sourceCrawlId,
        attemptKey,
        textValue(input.externalId),
        textValue(input.postingUrl),
        textValue(input.canonicalUrl),
        textValue(input.title),
        textValue(input.companyName),
        textValue(input.contentFingerprint),
        input.contentVersion ?? 0,
        input.rawJson ?? '{}',
      ],
    );
    return attemptRecord(result.rows[0]);
  });
}

/** Persist final resolved identities before Opportunity writes. */
export async function prepareSourceCrawlAttempt(
  db: SmrtDatabase,
  input: PrepareSourceCrawlAttemptInput,
): Promise<SourceCrawlAttemptRecord> {
  const sourceCrawlId = requiredText(input.sourceCrawlId, 'sourceCrawlId');
  const attemptKey = requiredText(input.attemptKey, 'attemptKey');
  if (typeof db.transaction !== 'function') {
    throw new Error('Source crawl accounting requires database transactions.');
  }
  return await db.transaction(async (transaction) => {
    await lockRunningSourceCrawl(transaction, sourceCrawlId);
    const result = await transaction.query(
      `UPDATE source_crawl_items
       SET external_id = ?, posting_url = ?, canonical_url = ?,
           title = ?, company_name = ?, raw_json = ?,
           status = ?, updated_at = CURRENT_TIMESTAMP
       WHERE source_crawl_id = ? AND attempt_key = ? AND outcome = 'pending'
       RETURNING
         id::text AS id,
         source_crawl_id AS "sourceCrawlId",
         attempt_key AS "attemptKey",
         outcome,
         opportunity_id AS "opportunityId",
         COALESCE(duplicate_of_source_crawl_item_id, '') AS "duplicateOfSourceCrawlItemId",
         COALESCE(status, '') AS status,
         COALESCE(reason, '') AS reason,
         terminal_at AS "terminalAt"`,
      [
        textValue(input.externalId),
        textValue(input.postingUrl),
        textValue(input.canonicalUrl),
        textValue(input.title),
        textValue(input.companyName),
        input.rawJson ?? '{}',
        'pending',
        sourceCrawlId,
        attemptKey,
      ],
    );
    if (result.rows.length !== 1) {
      throw new Error(
        `Source crawl attempt ${sourceCrawlId}/${attemptKey} is no longer pending.`,
      );
    }
    return attemptRecord(result.rows[0]);
  });
}

/** Record the exact terminal outcome intended before Opportunity persistence. */
export async function recordSourceCrawlAttemptPersistenceIntent(
  db: SmrtDatabase,
  input: {
    attemptKey: string;
    intent: SourceCrawlPersistenceIntent;
    opportunityId: string;
    sourceCrawlId: string;
  },
): Promise<SourceCrawlAttemptRecord> {
  const sourceCrawlId = requiredText(input.sourceCrawlId, 'sourceCrawlId');
  const attemptKey = requiredText(input.attemptKey, 'attemptKey');
  const opportunityId = requiredText(input.opportunityId, 'opportunityId');
  if (typeof db.transaction !== 'function') {
    throw new Error('Source crawl accounting requires database transactions.');
  }
  return await db.transaction(async (transaction) => {
    await lockRunningSourceCrawl(transaction, sourceCrawlId);
    return await recordPersistenceIntentLocked(transaction, {
      ...input,
      attemptKey,
      opportunityId,
      sourceCrawlId,
    });
  });
}

/** Persist a non-Opportunity terminal decision before its terminal write. */
export async function recordSourceCrawlAttemptTerminalIntent(
  db: SmrtDatabase,
  input: {
    attemptKey: string;
    outcome: SourceCrawlNonPersistenceIntent;
    sourceCrawlId: string;
    status: string;
  },
): Promise<SourceCrawlAttemptRecord> {
  const sourceCrawlId = requiredText(input.sourceCrawlId, 'sourceCrawlId');
  const attemptKey = requiredText(input.attemptKey, 'attemptKey');
  const terminalStatus = requiredText(input.status, 'status');
  const status = `pending_${input.outcome}:${terminalStatus}`;
  if (typeof db.transaction !== 'function') {
    throw new Error('Source crawl accounting requires database transactions.');
  }
  return await db.transaction(async (transaction) => {
    await lockRunningSourceCrawl(transaction, sourceCrawlId);
    const result = await transaction.query(
      `UPDATE source_crawl_items
       SET status = ?, updated_at = CURRENT_TIMESTAMP
       WHERE source_crawl_id = ? AND attempt_key = ? AND outcome = 'pending'
         AND status IN ('pending', ?)
       RETURNING
         id::text AS id,
         source_crawl_id AS "sourceCrawlId",
         attempt_key AS "attemptKey",
         outcome,
         opportunity_id AS "opportunityId",
         COALESCE(duplicate_of_source_crawl_item_id, '') AS "duplicateOfSourceCrawlItemId",
         COALESCE(status, '') AS status,
         COALESCE(reason, '') AS reason,
         terminal_at AS "terminalAt"`,
      [status, sourceCrawlId, attemptKey, status],
    );
    if (result.rows.length !== 1) {
      throw new Error(
        `Source crawl attempt ${sourceCrawlId}/${attemptKey} cannot record terminal intent ${input.outcome}.`,
      );
    }
    return attemptRecord(result.rows[0]);
  });
}

/**
 * Recover Opportunity writes committed immediately before worker process loss.
 * The caller must own the parent crawl lock. Ambiguous identities fail closed.
 */
export async function recoverPendingSourceCrawlAttempts(
  db: QueryableDatabase,
  sourceCrawlId: string,
  terminalAt = new Date(),
): Promise<number> {
  const id = requiredText(sourceCrawlId, 'sourceCrawlId');
  const matches = await db.query(
    `SELECT
       item.id::text AS "itemId",
       item.status AS "itemStatus",
       opportunity.id::text AS "opportunityId"
     FROM source_crawl_items AS item
     JOIN source_crawls AS crawl
       ON CAST(crawl.id AS TEXT) = item.source_crawl_id
     LEFT JOIN opportunities AS opportunity
       ON (
        (NULLIF(BTRIM(item.external_id), '') IS NOT NULL
          AND opportunity.source_id = crawl.source_id
          AND opportunity.external_id = item.external_id)
        OR
        (NULLIF(RTRIM(LOWER(BTRIM(item.posting_url)), '/'), '') IS NOT NULL
          AND RTRIM(LOWER(BTRIM(item.posting_url)), '/') IN (
            RTRIM(LOWER(BTRIM(opportunity.posting_url)), '/'),
            RTRIM(LOWER(BTRIM(opportunity.canonical_url)), '/')
          ))
        OR
        (NULLIF(RTRIM(LOWER(BTRIM(item.canonical_url)), '/'), '') IS NOT NULL
          AND RTRIM(LOWER(BTRIM(item.canonical_url)), '/') IN (
            RTRIM(LOWER(BTRIM(opportunity.posting_url)), '/'),
            RTRIM(LOWER(BTRIM(opportunity.canonical_url)), '/')
          ))
        OR
        EXISTS (
          SELECT 1
          FROM jsonb_each_text(
            CASE
              WHEN jsonb_typeof(
                COALESCE(NULLIF(BTRIM(item.raw_json), '')::jsonb, '{}'::jsonb)
                -> 'recoveryIdentities'
              ) = 'object'
              THEN COALESCE(NULLIF(BTRIM(item.raw_json), '')::jsonb, '{}'::jsonb)
                -> 'recoveryIdentities'
              ELSE '{}'::jsonb
            END
          ) AS identity(key, value)
          WHERE
            (identity.key = 'externalId'
              AND opportunity.source_id = crawl.source_id
              AND opportunity.external_id = identity.value)
            OR
            (identity.key <> 'externalId'
              AND NULLIF(RTRIM(LOWER(BTRIM(identity.value)), '/'), '') IS NOT NULL
              AND RTRIM(LOWER(BTRIM(identity.value)), '/') IN (
                RTRIM(LOWER(BTRIM(opportunity.posting_url)), '/'),
                RTRIM(LOWER(BTRIM(opportunity.canonical_url)), '/')
              ))
        )
      )
     WHERE item.source_crawl_id = ? AND item.outcome = 'pending'
     ORDER BY item.id, opportunity.id`,
    [id],
  );
  const byItem = new Map<
    string,
    {
      itemStatus: string;
      opportunities: Set<string>;
    }
  >();
  for (const row of matches.rows) {
    const itemId = textValue(row.itemId);
    if (!itemId) continue;
    let item = byItem.get(itemId);
    if (!item) {
      item = {
        itemStatus: textValue(row.itemStatus),
        opportunities: new Set(),
      };
      byItem.set(itemId, item);
    }
    const opportunityId = textValue(row.opportunityId);
    if (!opportunityId) continue;
    item.opportunities.add(opportunityId);
  }
  let recovered = 0;
  for (const [itemId, item] of byItem) {
    const [intentStatus = '', intendedOpportunityId = ''] =
      item.itemStatus.split(':', 2);
    const outcome = intentStatus.startsWith('pending_')
      ? intentStatus.slice('pending_'.length)
      : '';
    if (item.opportunities.size > 1) {
      throw new Error(
        `Source crawl attempt ${id}/${itemId} matches multiple durable opportunities.`,
      );
    }
    if (outcome === 'duplicate' || outcome === 'skipped') {
      const updated = await db.query(
        `UPDATE source_crawl_items
         SET outcome = ?, opportunity_id = NULL, status = ?,
             reason = 'Recovered intended terminal outcome after interrupted accounting.',
             terminal_at = ?, updated_at = CURRENT_TIMESTAMP
         WHERE id = ? AND source_crawl_id = ? AND outcome = 'pending'`,
        [outcome, intendedOpportunityId || outcome, terminalAt, itemId, id],
      );
      if (updated.rowCount === 1) recovered += 1;
      continue;
    }
    if (item.opportunities.size === 0) continue;
    if (!['created', 'relisted', 'reused'].includes(outcome)) {
      throw new Error(
        `Source crawl attempt ${id}/${itemId} has a durable opportunity but no unambiguous persistence intent.`,
      );
    }
    const opportunityId = item.opportunities.values().next().value;
    if (!opportunityId) continue;
    if (!intendedOpportunityId) {
      throw new Error(
        `Source crawl attempt ${id}/${itemId} has no attributed Opportunity id.`,
      );
    }
    if (opportunityId !== intendedOpportunityId) {
      if (outcome === 'created') continue;
      throw new Error(
        `Source crawl attempt ${id}/${itemId} matched ${opportunityId}, not its intended Opportunity ${intendedOpportunityId}.`,
      );
    }
    const updated = await db.query(
      `UPDATE source_crawl_items
       SET outcome = ?, opportunity_id = ?, status = ?,
           reason = 'Recovered durable opportunity after interrupted terminal accounting.',
           terminal_at = ?, updated_at = CURRENT_TIMESTAMP
       WHERE id = ? AND source_crawl_id = ? AND outcome = 'pending'`,
      [
        outcome as SourceCrawlTerminalOutcome,
        opportunityId,
        outcome === 'created' ? 'created_opportunity' : 'duplicate',
        terminalAt,
        itemId,
        id,
      ],
    );
    if (updated.rowCount === 1) recovered += 1;
  }
  return recovered;
}

/**
 * Persist a newly-created Opportunity and its terminal attempt under one
 * parent-row fence. The callback must write through the supplied transaction.
 */
export async function persistCreatedSourceCrawlAttempt<T>(
  db: SmrtDatabase,
  input: PersistCreatedSourceCrawlAttemptInput,
  persistOpportunity: (transaction: QueryableDatabase) => Promise<T>,
): Promise<{ attempt: SourceCrawlAttemptRecord; value: T }> {
  const sourceCrawlId = requiredText(input.sourceCrawlId, 'sourceCrawlId');
  const attemptKey = requiredText(input.attemptKey, 'attemptKey');
  const opportunityId = requiredText(input.opportunityId, 'opportunityId');
  if (typeof db.transaction !== 'function') {
    throw new Error('Source crawl accounting requires database transactions.');
  }
  return await db.transaction(async (transaction) => {
    await lockRunningSourceCrawl(transaction, sourceCrawlId);
    await recordPersistenceIntentLocked(transaction, {
      attemptKey,
      intent: 'created',
      opportunityId,
      sourceCrawlId,
    });
    const value = await persistOpportunity(transaction);
    const attempt = await finalizeLockedSourceCrawlAttempt(transaction, {
      ...input,
      attemptKey,
      opportunityId,
      outcome: 'created',
      sourceCrawlId,
    });
    await reconcileLockedSourceCrawlAccounting(transaction, sourceCrawlId);
    return { attempt, value };
  });
}

/** Recover one uncertain Opportunity write while the crawl is still running. */
export async function recoverSourceCrawlAttempt(
  db: SmrtDatabase,
  input: { attemptKey: string; sourceCrawlId: string },
): Promise<SourceCrawlTerminalOutcome | null> {
  const sourceCrawlId = requiredText(input.sourceCrawlId, 'sourceCrawlId');
  const attemptKey = requiredText(input.attemptKey, 'attemptKey');
  if (typeof db.transaction !== 'function') {
    throw new Error('Source crawl accounting requires database transactions.');
  }
  return await db.transaction(async (transaction) => {
    await lockRunningSourceCrawl(transaction, sourceCrawlId);
    await recoverPendingSourceCrawlAttempts(transaction, sourceCrawlId);
    await reconcileLockedSourceCrawlAccounting(transaction, sourceCrawlId);
    const result = await transaction.query(
      `SELECT outcome
       FROM source_crawl_items
       WHERE source_crawl_id = ? AND attempt_key = ?`,
      [sourceCrawlId, attemptKey],
    );
    const outcome = textValue(result.rows[0]?.outcome);
    return SOURCE_CRAWL_TERMINAL_OUTCOMES.includes(
      outcome as SourceCrawlTerminalOutcome,
    )
      ? (outcome as SourceCrawlTerminalOutcome)
      : null;
  });
}

/**
 * Fence a terminal outcome so retries can repeat the same decision but cannot
 * overwrite a committed outcome. Aggregate counters reconcile in the same
 * parent-row-locked transaction.
 */
export async function finalizeSourceCrawlAttempt(
  db: SmrtDatabase,
  input: FinalizeSourceCrawlAttemptInput,
): Promise<SourceCrawlAttemptRecord> {
  const sourceCrawlId = requiredText(input.sourceCrawlId, 'sourceCrawlId');
  if (input.outcome === 'created' && !textValue(input.opportunityId)) {
    throw new Error('A created source crawl attempt requires opportunityId.');
  }
  if (typeof db.transaction !== 'function') {
    throw new Error('Source crawl accounting requires database transactions.');
  }
  return await db.transaction(async (transaction) => {
    await lockSourceCrawl(transaction, sourceCrawlId);
    const record = await finalizeLockedSourceCrawlAttempt(transaction, input);
    await reconcileLockedSourceCrawlAccounting(transaction, sourceCrawlId);
    return record;
  });
}

async function finalizeLockedSourceCrawlAttempt(
  db: QueryableDatabase,
  input: FinalizeSourceCrawlAttemptInput,
): Promise<SourceCrawlAttemptRecord> {
  const sourceCrawlId = requiredText(input.sourceCrawlId, 'sourceCrawlId');
  const attemptKey = requiredText(input.attemptKey, 'attemptKey');
  const updated = await db.query(
    `UPDATE source_crawl_items
       SET outcome = ?,
           opportunity_id = ?,
           duplicate_of_source_crawl_item_id = ?,
           status = ?,
           reason = ?,
           content_fingerprint = COALESCE(?, content_fingerprint),
           content_version = COALESCE(?, content_version),
           external_id = COALESCE(?, external_id),
           posting_url = COALESCE(?, posting_url),
           canonical_url = COALESCE(?, canonical_url),
           title = COALESCE(?, title),
           company_name = COALESCE(?, company_name),
           raw_json = COALESCE(?, raw_json),
           terminal_at = CURRENT_TIMESTAMP,
           updated_at = CURRENT_TIMESTAMP
       WHERE source_crawl_id = ?
         AND attempt_key = ?
         AND outcome = 'pending'
       RETURNING
         id::text AS id,
         source_crawl_id AS "sourceCrawlId",
         attempt_key AS "attemptKey",
         outcome,
         opportunity_id AS "opportunityId",
         COALESCE(duplicate_of_source_crawl_item_id, '') AS "duplicateOfSourceCrawlItemId",
         COALESCE(status, '') AS status,
         COALESCE(reason, '') AS reason,
         terminal_at AS "terminalAt"`,
    [
      input.outcome,
      textValue(input.opportunityId) || null,
      textValue(input.duplicateOfSourceCrawlItemId),
      input.status ?? input.outcome,
      textValue(input.reason),
      input.contentFingerprint ?? null,
      input.contentVersion ?? null,
      input.externalId ?? null,
      input.postingUrl ?? null,
      input.canonicalUrl ?? null,
      input.title ?? null,
      input.companyName ?? null,
      input.rawJson ?? null,
      sourceCrawlId,
      attemptKey,
    ],
  );
  if (updated.rows.length === 1) {
    return attemptRecord(updated.rows[0]);
  }
  const existing = await selectAttempt(db, sourceCrawlId, attemptKey);
  if (!existing) {
    throw new Error(
      `Source crawl attempt ${sourceCrawlId}/${attemptKey} does not exist.`,
    );
  }
  if (existing.outcome !== input.outcome) {
    throw new Error(
      `Source crawl attempt ${sourceCrawlId}/${attemptKey} is already terminal with outcome ${existing.outcome}.`,
    );
  }
  return existing;
}

async function recordPersistenceIntentLocked(
  db: QueryableDatabase,
  input: {
    attemptKey: string;
    intent: SourceCrawlPersistenceIntent;
    opportunityId: string;
    sourceCrawlId: string;
  },
): Promise<SourceCrawlAttemptRecord> {
  const status = `pending_${input.intent}:${input.opportunityId}`;
  const result = await db.query(
    `UPDATE source_crawl_items
     SET status = ?, updated_at = CURRENT_TIMESTAMP
     WHERE source_crawl_id = ? AND attempt_key = ? AND outcome = 'pending'
       AND status IN ('pending', ?)
     RETURNING
       id::text AS id,
       source_crawl_id AS "sourceCrawlId",
       attempt_key AS "attemptKey",
       outcome,
       opportunity_id AS "opportunityId",
       COALESCE(duplicate_of_source_crawl_item_id, '') AS "duplicateOfSourceCrawlItemId",
       COALESCE(status, '') AS status,
       COALESCE(reason, '') AS reason,
       terminal_at AS "terminalAt"`,
    [status, input.sourceCrawlId, input.attemptKey, status],
  );
  if (result.rows.length !== 1) {
    throw new Error(
      `Source crawl attempt ${input.sourceCrawlId}/${input.attemptKey} cannot record persistence intent ${input.intent} for ${input.opportunityId}.`,
    );
  }
  return attemptRecord(result.rows[0]);
}

/** Rebuild crawl aggregates exclusively from committed attempt rows. */
export async function reconcileSourceCrawlAccounting(
  db: SmrtDatabase,
  sourceCrawlId: string,
  options: { requireTerminal?: boolean } = {},
): Promise<SourceCrawlAccounting> {
  const id = requiredText(sourceCrawlId, 'sourceCrawlId');
  if (typeof db.transaction !== 'function') {
    throw new Error('Source crawl accounting requires database transactions.');
  }
  return await db.transaction(async (transaction) => {
    await lockSourceCrawl(transaction, id);
    const accounting = await reconcileLockedSourceCrawlAccounting(
      transaction,
      id,
    );
    if (options.requireTerminal && accounting.pendingCount > 0) {
      throw new Error(
        `Source crawl ${id} has ${accounting.pendingCount} non-terminal attempts.`,
      );
    }
    return accounting;
  });
}

/** Reconcile while the caller owns the surrounding database transaction. */
export async function reconcileSourceCrawlAccountingTransaction(
  db: QueryableDatabase,
  sourceCrawlId: string,
): Promise<SourceCrawlAccounting> {
  const id = requiredText(sourceCrawlId, 'sourceCrawlId');
  await lockSourceCrawl(db, id);
  return await reconcileLockedSourceCrawlAccounting(db, id);
}

async function reconcileLockedSourceCrawlAccounting(
  db: QueryableDatabase,
  sourceCrawlId: string,
): Promise<SourceCrawlAccounting> {
  const result = await db.query(
    `SELECT
       COUNT(*)::integer AS "attemptCount",
       COUNT(*) FILTER (WHERE outcome = 'pending')::integer AS "pendingCount",
       COUNT(*) FILTER (WHERE outcome IN (
         'created', 'reused', 'relisted', 'duplicate', 'skipped',
         'failed_persistence'
       ))::integer AS "terminalCount",
       COUNT(*) FILTER (WHERE outcome = 'created')::integer AS "createdCount",
       COUNT(*) FILTER (WHERE outcome = 'reused')::integer AS "reusedCount",
       COUNT(*) FILTER (WHERE outcome = 'relisted')::integer AS "relistedCount",
       COUNT(*) FILTER (WHERE outcome = 'duplicate')::integer AS "duplicateCount",
       COUNT(*) FILTER (WHERE outcome = 'skipped')::integer AS "skippedCount",
       COUNT(*) FILTER (WHERE outcome = 'failed_persistence')::integer AS "failedPersistenceCount"
     FROM source_crawl_items
     WHERE source_crawl_id = ?
       AND NULLIF(BTRIM(attempt_key), '') IS NOT NULL`,
    [sourceCrawlId],
  );
  const accounting = accountingRecord(result.rows[0]);
  assertAccountingInvariant(accounting);
  const updated = await db.query(
    `UPDATE source_crawls
     SET result_count = ?,
         new_opportunity_count = ?,
         duplicate_count = ?,
         skipped_count = ?,
         attempt_count = ?,
         terminal_count = ?,
         pending_count = ?,
         reused_count = ?,
         relisted_count = ?,
         failed_persistence_count = ?,
         updated_at = CURRENT_TIMESTAMP
     WHERE id = ?`,
    [
      accounting.terminalCount,
      accounting.createdCount,
      accounting.duplicateCount,
      accounting.skippedCount,
      accounting.attemptCount,
      accounting.terminalCount,
      accounting.pendingCount,
      accounting.reusedCount,
      accounting.relistedCount,
      accounting.failedPersistenceCount,
      sourceCrawlId,
    ],
  );
  if (updated.rowCount !== 1) {
    throw new Error(`Source crawl ${sourceCrawlId} does not exist.`);
  }
  return accounting;
}

async function lockSourceCrawl(
  db: QueryableDatabase,
  sourceCrawlId: string,
): Promise<void> {
  const result = await db.query(
    'SELECT id FROM source_crawls WHERE id = ? FOR UPDATE',
    [sourceCrawlId],
  );
  if (result.rows.length !== 1) {
    throw new Error(`Source crawl ${sourceCrawlId} does not exist.`);
  }
}

async function lockRunningSourceCrawl(
  db: QueryableDatabase,
  sourceCrawlId: string,
): Promise<void> {
  const result = await db.query(
    `SELECT id
     FROM source_crawls
     WHERE id = ?
       AND status = 'running'
       AND finished_at IS NULL
     FOR UPDATE`,
    [sourceCrawlId],
  );
  if (result.rows.length !== 1) {
    throw new Error(`Source crawl ${sourceCrawlId} is no longer running.`);
  }
}

async function selectAttempt(
  db: QueryableDatabase,
  sourceCrawlId: string,
  attemptKey: string,
): Promise<SourceCrawlAttemptRecord | null> {
  const result = await db.query(
    `SELECT
       id::text AS id,
       source_crawl_id AS "sourceCrawlId",
       attempt_key AS "attemptKey",
       outcome,
       opportunity_id AS "opportunityId",
       COALESCE(duplicate_of_source_crawl_item_id, '') AS "duplicateOfSourceCrawlItemId",
       COALESCE(status, '') AS status,
       COALESCE(reason, '') AS reason,
       terminal_at AS "terminalAt"
     FROM source_crawl_items
     WHERE source_crawl_id = ? AND attempt_key = ?`,
    [sourceCrawlId, attemptKey],
  );
  return result.rows.length === 1 ? attemptRecord(result.rows[0]) : null;
}

function attemptRecord(row: Record<string, unknown>): SourceCrawlAttemptRecord {
  const outcome = textValue(row.outcome);
  if (outcome !== 'pending' && !isTerminalOutcome(outcome)) {
    throw new Error(
      `Invalid source crawl attempt outcome ${outcome || '<empty>'}.`,
    );
  }
  return {
    attemptKey: textValue(row.attemptKey),
    duplicateOfSourceCrawlItemId: textValue(row.duplicateOfSourceCrawlItemId),
    id: textValue(row.id),
    opportunityId: textValue(row.opportunityId) || null,
    outcome,
    reason: textValue(row.reason),
    sourceCrawlId: textValue(row.sourceCrawlId),
    status: textValue(row.status),
    terminalAt: (row.terminalAt as Date | string | null | undefined) ?? null,
  };
}

function accountingRecord(row: Record<string, unknown>): SourceCrawlAccounting {
  return {
    attemptCount: numberValue(row.attemptCount),
    createdCount: numberValue(row.createdCount),
    duplicateCount: numberValue(row.duplicateCount),
    failedPersistenceCount: numberValue(row.failedPersistenceCount),
    pendingCount: numberValue(row.pendingCount),
    relistedCount: numberValue(row.relistedCount),
    reusedCount: numberValue(row.reusedCount),
    skippedCount: numberValue(row.skippedCount),
    terminalCount: numberValue(row.terminalCount),
  };
}

function assertAccountingInvariant(accounting: SourceCrawlAccounting): void {
  const outcomeTotal =
    accounting.createdCount +
    accounting.reusedCount +
    accounting.relistedCount +
    accounting.duplicateCount +
    accounting.skippedCount +
    accounting.failedPersistenceCount;
  if (
    accounting.attemptCount !==
      accounting.pendingCount + accounting.terminalCount ||
    accounting.terminalCount !== outcomeTotal
  ) {
    throw new Error('Source crawl terminal accounting invariant failed.');
  }
}

function isTerminalOutcome(value: string): value is SourceCrawlTerminalOutcome {
  return (SOURCE_CRAWL_TERMINAL_OUTCOMES as readonly string[]).includes(value);
}

async function accountingTablesExist(db: QueryableDatabase): Promise<boolean> {
  const result = await db.query(`
    SELECT
      to_regclass('source_crawls') IS NOT NULL AS "crawlsExist",
      to_regclass('source_crawl_items') IS NOT NULL AS "itemsExist"
  `);
  return (
    result.rows[0]?.crawlsExist === true && result.rows[0]?.itemsExist === true
  );
}

function emptySchemaStatus(): SourceCrawlAccountingSchemaStatus {
  return {
    attemptIndexPresent: false,
    outcomeConstraintPresent: false,
    requiredColumnsPresent: 0,
    requiredColumnsTotal: REQUIRED_ACCOUNTING_COLUMNS.length,
  };
}

function requiredText(value: unknown, name: string): string {
  const normalized = textValue(value).trim();
  if (!normalized) throw new Error(`${name} is required.`);
  return normalized;
}

function textValue(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function numberValue(value: unknown): number {
  const number = Number(value ?? 0);
  return Number.isFinite(number) ? number : 0;
}
