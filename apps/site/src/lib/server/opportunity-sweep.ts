import { resolveDatabase } from '@happyvertical/smrt-core';
import { getRequestScopedDatabase, type User } from '@happyvertical/smrt-users';
import { error } from '@sveltejs/kit';
import { DECISION_REVIEW_STATUSES } from '$lib/opportunity-filters';
import {
  closeReviewTasksForArchivedOpportunities,
  recordAgentAudit,
} from './application-workflow.js';
import { bumpOpportunityChangeFeed } from './change-feed.js';
import { getDbConfig } from './db.js';
import {
  ARCHIVED_OPPORTUNITY_STATE,
  type OpportunityArchiveReason,
} from './posting-preflight.js';

/**
 * Stage 0 of the opportunity-retirement work (issue #427): opportunities under
 * a source that is no longer crawled can never be re-seen, so they must not
 * sit in `found` forever. This sweep archives exactly those rows — inactive
 * source, still undecided, not seen for N days — reusing the one archived
 * transition in `posting-preflight.ts` and recording a single `AgentRun` audit
 * per apply.
 *
 * It is dry-run first: `sweepInactiveSourceOpportunities()` writes nothing
 * unless the caller explicitly passes `dryRun: false`.
 */

/** Default owner decision (2026-09-02): archive after 30 days unseen. */
export const DEFAULT_SWEEP_NOT_SEEN_DAYS = 30;
export const MIN_SWEEP_NOT_SEEN_DAYS = 1;
export const MAX_SWEEP_NOT_SEEN_DAYS = 3_650;
export const SWEEP_SAMPLE_SIZE = 10;

/** The archive reason stamped on every row this sweep retires. */
export const SWEEP_ARCHIVE_REASON: OpportunityArchiveReason = 'source_inactive';

/**
 * The only statuses the sweep may touch. A row that carries a decision or an
 * application (`apply`, `applied`, `rejected`, …) is never swept, whatever its
 * source or age.
 */
export const SWEEPABLE_OPPORTUNITY_STATUSES = ['found', 'recommended'] as const;

/**
 * Human-review dispositions that record an owner decision. A row can carry one
 * of these while its lifecycle status is still `found`/`recommended` — "Maybe"
 * deliberately preserves the previous status, and an admin review can set the
 * disposition without moving the row — so the lifecycle status alone does not
 * identify a decided posting.
 */
export const PROTECTED_REVIEW_STATUSES = DECISION_REVIEW_STATUSES;

export interface OpportunitySweepSampleRow {
  id: string;
  lastSeenAt: string | null;
  sourceId: string;
  status: string;
  title: string;
}

export interface OpportunitySweepFilter {
  archiveReason: string;
  excludesApplications: true;
  excludesOwnerDecisions: true;
  excludesReviewStatuses: readonly string[];
  notSeenBefore: string;
  notSeenDays: number;
  sourceIsActive: false;
  statuses: readonly string[];
}

export interface OpportunitySweepResult {
  applied: boolean;
  archivedCount: number;
  auditRunId: string;
  count: number;
  dryRun: boolean;
  filter: OpportunitySweepFilter;
  /**
   * Rows the apply locked with `FOR UPDATE SKIP LOCKED` (#437). Lower than
   * `count` when another transaction held a candidate row; `archivedCount` is
   * lower again when a locked row turned out to be protected after all.
   */
  lockedCount: number;
  message: string;
  /** Open `review_recommendation` tasks closed alongside the archive (#434). */
  reviewTasksClosed: number;
  sample: OpportunitySweepSampleRow[];
  /** Locked rows the re-checked predicate refused to archive (#437). */
  skippedCount: number;
}

type SmrtDatabase = Awaited<ReturnType<typeof resolveDatabase>>;
type QueryResult =
  | { rows?: Record<string, unknown>[] }
  | Record<string, unknown>[];

async function sweepDatabase(): Promise<SmrtDatabase> {
  return getRequestScopedDatabase() ?? (await resolveDatabase(getDbConfig()));
}

function rowsFromResult(result: QueryResult): Record<string, unknown>[] {
  return Array.isArray(result) ? result : (result.rows ?? []);
}

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function isoOrNull(value: unknown): string | null {
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value.toISOString();
  }
  if (typeof value === 'string' && value.trim()) {
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
  }
  return null;
}

function countFromRows(rows: Record<string, unknown>[]): number {
  const raw = rows[0]?.count;
  const parsed =
    typeof raw === 'number' ? raw : Number.parseInt(String(raw ?? '0'), 10);
  return Number.isFinite(parsed) ? parsed : 0;
}

export function sweepNotSeenDays(value: unknown): number {
  if (value === undefined || value === null || value === '') {
    return DEFAULT_SWEEP_NOT_SEEN_DAYS;
  }
  const days = typeof value === 'number' ? value : Number(value);
  if (
    !Number.isInteger(days) ||
    days < MIN_SWEEP_NOT_SEEN_DAYS ||
    days > MAX_SWEEP_NOT_SEEN_DAYS
  ) {
    error(
      400,
      `Not-seen days must be an integer from ${MIN_SWEEP_NOT_SEEN_DAYS} to ${MAX_SWEEP_NOT_SEEN_DAYS}.`,
    );
  }
  return days;
}

export function sweepCutoff(notSeenDays: number, now: Date = new Date()): Date {
  return new Date(now.getTime() - notSeenDays * 86_400_000);
}

/**
 * The one match predicate, shared by the count, the sample, and the update, so
 * a dry run and its apply can never disagree.
 *
 * `last_seen_at IS NOT NULL` is deliberate: a row that was never stamped has
 * no age evidence, so the first sweep leaves it alone rather than guessing
 * from `created_at`.
 *
 * The lifecycle status is not on its own enough to tell a decided posting from
 * an undecided one. A "Maybe" decision and an admin review both record an
 * owner disposition in `human_review_status` while deliberately leaving the
 * row in `found`/`recommended`, and an accepted posting keeps an `Application`
 * row. All three are excluded here so the sweep can never overwrite an owner
 * decision — the disposition it would replace is not recoverable from the
 * archived row.
 */
const SWEEP_MATCH_SQL = `o.source_id <> ''
    AND EXISTS (
      SELECT 1 FROM sources s
      WHERE s.id = o.source_id AND s.is_active IS NOT TRUE
    )
    AND o.status = ANY($1::text[])
    AND o.last_seen_at IS NOT NULL
    AND o.last_seen_at < $2
    AND COALESCE(lower(btrim(o.human_review_status)), '') <> ALL($3::text[])
    AND NOT EXISTS (
      SELECT 1 FROM applications a WHERE a.opportunity_id = o.id
    )
    AND NOT EXISTS (
      SELECT 1 FROM decisions d
      WHERE d.opportunity_id = o.id AND d.decision_by = 'owner'
    )`;

function sweepFilter(
  notSeenDays: number,
  cutoff: Date,
): OpportunitySweepFilter {
  return {
    archiveReason: SWEEP_ARCHIVE_REASON,
    excludesApplications: true,
    excludesOwnerDecisions: true,
    excludesReviewStatuses: [...PROTECTED_REVIEW_STATUSES],
    notSeenBefore: cutoff.toISOString(),
    notSeenDays,
    sourceIsActive: false,
    statuses: [...SWEEPABLE_OPPORTUNITY_STATUSES],
  };
}

function sampleRow(row: Record<string, unknown>): OpportunitySweepSampleRow {
  return {
    id: stringValue(row.id),
    lastSeenAt: isoOrNull(row.lastSeenAt),
    sourceId: stringValue(row.sourceId),
    status: stringValue(row.status),
    title: stringValue(row.title) || 'Untitled opportunity',
  };
}

/**
 * Archive every undecided `found`/`recommended` opportunity whose source is
 * inactive and whose `last_seen_at` predates the cutoff.
 *
 * The apply is one batched `UPDATE` rather than a per-row `save()` loop: the
 * matched set can be thousands of rows and the transition is a fixed field
 * triple, so there is no per-row workflow to run. The triple itself is
 * `ARCHIVED_OPPORTUNITY_STATE` from `posting-preflight.ts`, the same one
 * `routeClosedPostingToExistingState()` applies. It archives, never deletes,
 * and is reversible per row.
 */
export async function sweepInactiveSourceOpportunities(
  options: {
    dryRun?: boolean;
    notSeenDays?: unknown;
    now?: Date;
    user?: Pick<User, 'id'> | null;
  } = {},
): Promise<OpportunitySweepResult> {
  const dryRun = options.dryRun !== false;
  const notSeenDays = sweepNotSeenDays(options.notSeenDays);
  const cutoff = sweepCutoff(notSeenDays, options.now ?? new Date());
  const filter = sweepFilter(notSeenDays, cutoff);
  const statuses = [...SWEEPABLE_OPPORTUNITY_STATUSES];
  const protectedReviewStatuses = [...PROTECTED_REVIEW_STATUSES];
  const db = await sweepDatabase();

  const countResult = await db.query(
    `SELECT count(*) AS count
    FROM opportunities o
    WHERE ${SWEEP_MATCH_SQL}`,
    statuses,
    cutoff,
    protectedReviewStatuses,
  );
  const count = countFromRows(rowsFromResult(countResult));

  const sampleResult = await db.query(
    `SELECT
      o.id,
      o.title,
      o.status,
      o.source_id AS "sourceId",
      o.last_seen_at AS "lastSeenAt"
    FROM opportunities o
    WHERE ${SWEEP_MATCH_SQL}
    ORDER BY o.last_seen_at ASC, o.id ASC
    LIMIT $4`,
    statuses,
    cutoff,
    protectedReviewStatuses,
    SWEEP_SAMPLE_SIZE,
  );
  const sample = rowsFromResult(sampleResult).map(sampleRow);

  if (dryRun) {
    return {
      applied: false,
      archivedCount: 0,
      auditRunId: '',
      count,
      dryRun: true,
      filter,
      message:
        count === 0
          ? `No opportunities under an inactive source have gone unseen for ${notSeenDays} days.`
          : `${count} opportunities under an inactive source have gone unseen for ${notSeenDays} days. Nothing was changed; confirm to archive them.`,
      lockedCount: 0,
      reviewTasksClosed: 0,
      sample,
      skippedCount: 0,
    };
  }

  const state = {
    ...ARCHIVED_OPPORTUNITY_STATE,
    archiveReason: SWEEP_ARCHIVE_REASON,
  };
  if (!db.transaction) {
    throw new Error(
      'Transactional archival is required for the inactive-source sweep.',
    );
  }

  /*
   * The batched archive and its `AgentRun` are one unit of work. Neither
   * `executeAsPrincipal()` nor the request-scoped database opens a
   * transaction, so without this an audit failure would leave thousands of
   * archived, default-hidden rows with no record of the counts, the filter, or
   * who ran the sweep. PostgreSQL re-enters an enclosing transaction under a
   * savepoint, so this is safe inside a request that already holds one.
   */
  const { archivedCount, audit, lockedCount, reviewTasksClosed, skippedCount } =
    await db.transaction(async (tx) => {
      /*
       * Issue #437: under read-committed, a `Decision`, an `Application`, or a
       * source re-activation committed *while* a single archiving `UPDATE`
       * runs is invisible to that statement's snapshot, so a row that has just
       * become protected could still be archived `source_inactive`.
       *
       * The apply is therefore two statements. This one takes a row lock on
       * the candidate set; `SKIP LOCKED` steps over anything another
       * transaction is already writing rather than waiting on it, so a
       * concurrent owner decision costs the sweep that row instead of blocking
       * the sweep (or the owner). `FOR UPDATE OF o` locks only the opportunity
       * rows — never the `sources`, `applications`, or `decisions` rows the
       * predicate reads.
       */
      const lockResult = await tx.query(
        `SELECT o.id
      FROM opportunities o
      WHERE ${SWEEP_MATCH_SQL}
      ORDER BY o.id
      FOR UPDATE OF o SKIP LOCKED`,
        statuses,
        cutoff,
        protectedReviewStatuses,
      );
      const lockedIds = rowsFromResult(lockResult)
        .map((row) => stringValue(row.id))
        .filter((id) => id.length > 0);

      /*
       * And this one archives exactly the locked rows, re-evaluating the whole
       * match predicate against a fresh snapshot. A row that gained a
       * protecting artifact after the preview — or after the lock query's own
       * snapshot — no longer matches and is left alone; the difference is
       * reported as `skippedCount` rather than silently discarded.
       */
      const updateResult = lockedIds.length
        ? await tx.query(
            `UPDATE opportunities o
      SET status = $4,
        human_review_status = $5,
        freshness = $6,
        archive_reason = $7,
        updated_at = now()
      WHERE o.id = ANY($8::text[])
        AND ${SWEEP_MATCH_SQL}
      RETURNING o.id`,
            statuses,
            cutoff,
            protectedReviewStatuses,
            state.status,
            state.humanReviewStatus,
            state.freshness,
            state.archiveReason,
            lockedIds,
          )
        : { rows: [] };
      const archivedIds = rowsFromResult(updateResult).map((row) =>
        stringValue(row.id),
      );
      const archived = archivedIds.length;
      const skipped = lockedIds.length - archived;

      // Issue #436: the archive is one raw statement, so nothing feeds SMRT's
      // change feed for it. Bumping here, inside the same transaction, is what
      // lets a mounted admin list observe the sweep without a reload.
      await bumpOpportunityChangeFeed(tx, archivedIds);

      // Issue #434: an archived posting must not leave an open review task
      // behind. Closing them here, inside the same transaction as the archive,
      // keeps the task list from showing work against a retired posting.
      const closed = await closeReviewTasksForArchivedOpportunities({
        archiveReason: SWEEP_ARCHIVE_REASON,
        database: tx,
        opportunityIds: archivedIds,
      });

      const run = await recordAgentAudit({
        database: tx,
        input: {
          action: 'sweep_inactive_source_opportunities',
          dryRun: false,
          ...filter,
        },
        output: {
          archiveReason: SWEEP_ARCHIVE_REASON,
          archivedCount: archived,
          lockedCount: lockedIds.length,
          matchedCount: count,
          reviewTasksClosed: closed,
          sample,
          skippedCount: skipped,
        },
        runType: 'opportunity_sweep_source_inactive',
        status: 'completed',
        user: options.user,
      });

      return {
        archivedCount: archived,
        audit: run,
        lockedCount: lockedIds.length,
        reviewTasksClosed: closed,
        skippedCount: skipped,
      };
    });

  return {
    applied: true,
    archivedCount,
    auditRunId: stringValue(audit.id),
    count,
    dryRun: false,
    filter,
    lockedCount,
    message:
      archivedCount === 0
        ? `No opportunities matched the inactive-source sweep at ${notSeenDays} days.`
        : `Archived ${archivedCount} opportunities under inactive sources not seen for ${notSeenDays} days.${
            skippedCount > 0
              ? ` ${skippedCount} were skipped because they gained a decision, an application, or an active source after the preview.`
              : ''
          }`,
    reviewTasksClosed,
    sample,
    skippedCount,
  };
}
