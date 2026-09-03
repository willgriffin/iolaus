import { resolveDatabase } from '@happyvertical/smrt-core';
import {
  closeReviewTasksForArchivedOpportunities,
  recordAgentAudit,
} from './application-workflow.js';
import { bumpOpportunityChangeFeed } from './change-feed.js';
import { getDbConfig } from './db.js';
import { routeClosedPostingToExistingState } from './posting-preflight.js';
import { getCollection } from './smrt.js';

/**
 * Board reconciliation for a source crawl.
 *
 * A crawl of a listable board is the only trustworthy signal that a posting is
 * still listed. Every posting the board returned is re-stamped as seen; every
 * reconcilable posting of that source the board did not return counts as one
 * consecutive miss. After {@link BOARD_ABSENCE_ARCHIVE_THRESHOLD} consecutive
 * misses the posting is archived through the existing closed-posting
 * transition with reason `not_listed`. Postings are never deleted, and rows
 * carrying an owner decision (any status outside
 * {@link RECONCILABLE_OPPORTUNITY_STATUSES}) are never touched.
 */
export const BOARD_ABSENCE_ARCHIVE_THRESHOLD = 3;

/** The archive reason this reconciler writes, and the only one it will undo. */
export const BOARD_ABSENCE_ARCHIVE_REASON = 'not_listed';

/** Statuses a board crawl may re-stamp, miss, or archive. */
export const RECONCILABLE_OPPORTUNITY_STATUSES = ['found', 'recommended'];

const ID_BATCH_SIZE = 500;

export interface BoardReconciliationCounts {
  /** Postings archived because they reached the consecutive-miss threshold. */
  archived: number;
  /** Postings of this source the board did not list on this crawl. */
  missed: number;
  /** Postings whose `lastSeenAt`/`freshness` this crawl re-stamped. */
  refreshed: number;
  /** Distinct opportunities this crawl matched or created. */
  seen: number;
}

type QueryResult = { rowCount?: number; rows?: Record<string, unknown>[] };

export type ReconciliationDatabase = {
  query: (sql: string, params?: unknown[]) => Promise<QueryResult>;
  /**
   * Optional on the type only so a caller may hand in a narrow test double for
   * the read-shaped helpers; {@link reconcileSourceBoard} requires it and
   * refuses to mutate without one. PostgreSQL re-enters an enclosing
   * transaction under a savepoint, so nesting is safe inside a request that
   * already holds one.
   */
  transaction?: <T>(
    run: (tx: ReconciliationDatabase) => Promise<T>,
  ) => Promise<T>;
};

type MutableOpportunity = Record<string, unknown> & {
  save: () => Promise<void>;
};

function emptyCounts(): BoardReconciliationCounts {
  return { archived: 0, missed: 0, refreshed: 0, seen: 0 };
}

function uniqueIds(ids: Iterable<string>): string[] {
  const unique = new Set<string>();
  for (const id of ids) {
    const value = typeof id === 'string' ? id.trim() : '';
    if (value) unique.add(value);
  }
  return [...unique];
}

function chunked<T>(values: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let index = 0; index < values.length; index += size) {
    chunks.push(values.slice(index, index + size));
  }
  return chunks;
}

function statusPlaceholders(): string {
  return RECONCILABLE_OPPORTUNITY_STATUSES.map(() => '?').join(', ');
}

function returnedIds(result: QueryResult): string[] {
  const rows = Array.isArray(result?.rows) ? result.rows : [];
  return rows.map((row) => String(row.id ?? '')).filter((id) => id.length > 0);
}

function rowCount(result: QueryResult): number {
  if (Array.isArray(result?.rows)) return result.rows.length;
  const affected = result?.rowCount;
  return typeof affected === 'number' && Number.isFinite(affected)
    ? affected
    : 0;
}

async function reconciliationDatabase(
  database?: ReconciliationDatabase,
): Promise<ReconciliationDatabase> {
  if (database) return database;
  const resolved = (await resolveDatabase(
    getDbConfig(),
  )) as unknown as ReconciliationDatabase;
  if (typeof resolved?.query !== 'function') {
    throw new Error('Board reconciliation requires a queryable database.');
  }
  return resolved;
}

/**
 * Re-stamps every posting this crawl saw. This is the fix for `lastSeenAt`
 * having tracked first-seen: the crawler's match path returns an existing
 * opportunity without touching its freshness, so the whole crawl's matched ids
 * are re-stamped here in one batched update instead of one save() per row.
 */
export async function refreshSeenOpportunities(options: {
  database?: ReconciliationDatabase;
  now: Date;
  opportunityIds: Iterable<string>;
}): Promise<number> {
  const ids = uniqueIds(options.opportunityIds);
  if (ids.length === 0) return 0;
  const database = await reconciliationDatabase(options.database);
  let refreshed = 0;
  const changedIds: string[] = [];
  for (const batch of chunked(ids, ID_BATCH_SIZE)) {
    const result = await database.query(
      `UPDATE opportunities
          SET last_seen_at = ?,
              freshness = 'fresh',
              missed_crawls = 0,
              last_missed_at = NULL,
              updated_at = CURRENT_TIMESTAMP
        WHERE id IN (${batch.map(() => '?').join(', ')})
          AND status IN (${statusPlaceholders()})
        RETURNING id::text AS id`,
      [options.now, ...batch, ...RECONCILABLE_OPPORTUNITY_STATUSES],
    );
    refreshed += rowCount(result);
    changedIds.push(...returnedIds(result));
    // Archival by this reconciler is a reversible inference, not an owner
    // decision: if the board lists the posting again, undo it. Only rows this
    // reconciler archived are eligible — `archive_reason = 'not_listed'` is
    // written nowhere else, so a posting archived by the owner or by the
    // closed-posting preflight (which leaves the reason empty) is never
    // resurrected.
    const revived = await database.query(
      `UPDATE opportunities
          SET last_seen_at = ?,
              freshness = 'fresh',
              missed_crawls = 0,
              last_missed_at = NULL,
              archive_reason = '',
              human_review_status = 'needs_input',
              status = 'found',
              updated_at = CURRENT_TIMESTAMP
        WHERE id IN (${batch.map(() => '?').join(', ')})
          AND status = 'archived'
          AND archive_reason = ?
        RETURNING id::text AS id`,
      [options.now, ...batch, BOARD_ABSENCE_ARCHIVE_REASON],
    );
    refreshed += rowCount(revived);
    changedIds.push(...returnedIds(revived));
  }
  // Issue #436: these are raw statements, so nothing feeds SMRT's change feed
  // for them. Without this a mounted admin list keeps its cursor and shows the
  // pre-crawl freshness until it is reloaded.
  await bumpOpportunityChangeFeed(database, changedIds);
  return refreshed;
}

async function markAbsentOpportunities(options: {
  database: ReconciliationDatabase;
  now: Date;
  seenOpportunityIds: string[];
  sourceId: string;
}): Promise<{ archivableIds: string[]; missed: number }> {
  const seen = options.seenOpportunityIds;
  const result = await options.database.query(
    `UPDATE opportunities
        SET freshness = 'stale',
            missed_crawls = COALESCE(missed_crawls, 0) + 1,
            last_missed_at = ?,
            updated_at = CURRENT_TIMESTAMP
      WHERE source_id = ?
        AND status IN (${statusPlaceholders()})
        ${seen.length ? `AND id NOT IN (${seen.map(() => '?').join(', ')})` : ''}
      RETURNING id::text AS id, missed_crawls AS "missedCrawls"`,
    [
      options.now,
      options.sourceId,
      ...RECONCILABLE_OPPORTUNITY_STATUSES,
      ...seen,
    ],
  );
  const rows = Array.isArray(result?.rows) ? result.rows : [];
  const archivableIds = rows
    .filter((row) => {
      const misses = Number(row.missedCrawls ?? row.missed_crawls ?? 0);
      return (
        Number.isFinite(misses) && misses >= BOARD_ABSENCE_ARCHIVE_THRESHOLD
      );
    })
    .map((row) => String(row.id ?? ''))
    .filter((id) => id.length > 0);
  await bumpOpportunityChangeFeed(
    options.database,
    rows.map((row) => String(row.id ?? '')),
  );
  return { archivableIds, missed: rows.length };
}

/**
 * One unarchivable row must not cost the whole crawl its audit or block the
 * rest of the batch: a legacy row that cannot persist (see issue #431) would
 * otherwise abort reconciliation after the miss counters had already been
 * committed, leaving mutated state with no `AgentRun` to explain it.
 *
 * Because the whole reconciliation now runs inside one transaction (issue
 * #433), a raised save error would poison the enclosing transaction rather
 * than merely being caught here. Each row therefore archives inside its own
 * nested transaction — a savepoint on PostgreSQL — so the failure rolls back
 * that row alone and the surrounding work stays committable.
 */
async function archiveNotListedOpportunities(
  opportunityIds: string[],
  database: ReconciliationDatabase,
): Promise<{ archiveFailed: number; archivedIds: string[] }> {
  if (opportunityIds.length === 0) return { archiveFailed: 0, archivedIds: [] };
  const opportunities = await getCollection('Opportunity', {
    db: database as never,
  });
  let archiveFailed = 0;
  const archivedIds: string[] = [];
  for (const opportunityId of opportunityIds) {
    try {
      await withRowSavepoint(database, async () => {
        const opportunity = (await opportunities.get(
          opportunityId,
        )) as unknown as MutableOpportunity | null;
        if (!opportunity) return;
        if (
          !RECONCILABLE_OPPORTUNITY_STATUSES.includes(
            String(opportunity.status),
          )
        ) {
          return;
        }
        await routeClosedPostingToExistingState(opportunity, {
          archiveReason: BOARD_ABSENCE_ARCHIVE_REASON,
        });
        archivedIds.push(opportunityId);
      });
    } catch {
      // Counted, audited, and retried on the next crawl: the row keeps its
      // miss counter, so it stays archivable.
      archiveFailed += 1;
    }
  }
  return { archiveFailed, archivedIds };
}

async function withRowSavepoint(
  database: ReconciliationDatabase,
  run: () => Promise<void>,
): Promise<void> {
  if (typeof database.transaction !== 'function') {
    await run();
    return;
  }
  await database.transaction(async () => {
    await run();
  });
}

function auditPayload(options: {
  archiveFailed: number;
  counts: BoardReconciliationCounts;
  failure: unknown;
  reconcileAbsence: boolean;
  reviewTasksClosed: number;
  sourceCrawlId: string;
  sourceId: string;
}) {
  const { archiveFailed, counts, failure } = options;
  return {
    error:
      failure instanceof Error
        ? failure.message
        : failure
          ? String(failure)
          : undefined,
    input: {
      action: 'reconcile_source_board',
      archiveThreshold: BOARD_ABSENCE_ARCHIVE_THRESHOLD,
      reconcileAbsence: options.reconcileAbsence,
      sourceCrawlId: options.sourceCrawlId,
      sourceId: options.sourceId,
    },
    output: {
      ...counts,
      archiveFailed,
      archiveReason: BOARD_ABSENCE_ARCHIVE_REASON,
      reviewTasksClosed: options.reviewTasksClosed,
      rolledBack: Boolean(failure),
    },
    runType: 'source_board_reconciliation',
    sourceId: options.sourceId,
    status: failure
      ? 'failed'
      : archiveFailed > 0
        ? 'completed_with_errors'
        : 'completed',
  };
}

/**
 * Reconciles one source's postings against a successful board crawl and
 * records the seen/refreshed/missed/archived counts as an `AgentRun` audit.
 *
 * Callers must only invoke this for a crawl that actually listed the board
 * (see `shouldReconcileSourceBoard` in the crawler); a failed, partial, or
 * limited crawl must never count as a miss.
 *
 * ## Atomicity (issue #433)
 *
 * The absence accounting, the archive transition, and the
 * `source_board_reconciliation` audit are one unit of work. Previously the
 * rows were mutated first and the audit was written afterwards, so an audit
 * failure left thousands of re-stamped and archived rows with no run-level
 * record of what happened. Now they commit or roll back together:
 *
 * - an audit failure rolls the archive (and the miss counters) back;
 * - a mutation failure aborts before any audit is committed, so a rolled-back
 *   crawl can never leave a `completed` audit behind.
 *
 * A rollback is itself worth recording, so a separate `failed` audit is
 * written outside the aborted transaction. It is best-effort: if the audit
 * write is the thing that is broken, the original failure still propagates.
 */
export async function reconcileSourceBoard(options: {
  database?: ReconciliationDatabase;
  now: Date;
  /**
   * Whether this crawl may count absence. False re-stamps what the crawl saw
   * and nothing else, which is always safe; the caller decides, because only
   * the crawler knows whether the board was fully enumerated.
   */
  reconcileAbsence?: boolean;
  recordAudit?: boolean;
  seenOpportunityIds: Iterable<string>;
  sourceCrawlId?: string;
  sourceId: string;
}): Promise<BoardReconciliationCounts> {
  const sourceId = String(options.sourceId ?? '').trim();
  if (!sourceId) return emptyCounts();
  const database = await reconciliationDatabase(options.database);
  if (typeof database.transaction !== 'function') {
    throw new Error(
      'Transactional reconciliation is required for a source board crawl.',
    );
  }
  const seenOpportunityIds = uniqueIds(options.seenOpportunityIds);
  const reconcileAbsence = options.reconcileAbsence !== false;
  const sourceCrawlId = options.sourceCrawlId ?? '';
  const recordAudit = options.recordAudit !== false;

  try {
    return await database.transaction(async (tx) => {
      const counts: BoardReconciliationCounts = {
        ...emptyCounts(),
        seen: seenOpportunityIds.length,
      };
      let archiveFailed = 0;
      let reviewTasksClosed = 0;
      counts.refreshed = await refreshSeenOpportunities({
        database: tx,
        now: options.now,
        opportunityIds: seenOpportunityIds,
      });
      if (reconcileAbsence) {
        const { archivableIds, missed } = await markAbsentOpportunities({
          database: tx,
          now: options.now,
          seenOpportunityIds,
          sourceId,
        });
        counts.missed = missed;
        const outcome = await archiveNotListedOpportunities(archivableIds, tx);
        archiveFailed = outcome.archiveFailed;
        counts.archived = outcome.archivedIds.length;
        // Issue #434: an archived posting must not leave an open review task
        // behind. It closes in the same transition, so the task list never
        // shows work against a posting the board has stopped listing.
        reviewTasksClosed = await closeReviewTasksForArchivedOpportunities({
          archiveReason: BOARD_ABSENCE_ARCHIVE_REASON,
          database: tx as never,
          now: options.now,
          opportunityIds: outcome.archivedIds,
        });
      }
      if (recordAudit) {
        await recordAgentAudit({
          database: tx as never,
          ...auditPayload({
            archiveFailed,
            counts,
            failure: null,
            reconcileAbsence,
            reviewTasksClosed,
            sourceCrawlId,
            sourceId,
          }),
        });
      }
      return counts;
    });
  } catch (failure) {
    if (recordAudit) {
      try {
        await recordAgentAudit(
          auditPayload({
            archiveFailed: 0,
            counts: { ...emptyCounts(), seen: seenOpportunityIds.length },
            failure,
            reconcileAbsence,
            reviewTasksClosed: 0,
            sourceCrawlId,
            sourceId,
          }),
        );
      } catch {
        // The rollback already undid every mutation, so the crawl leaves no
        // unexplained state. Surface the original failure, not this one.
      }
    }
    throw failure;
  }
}
