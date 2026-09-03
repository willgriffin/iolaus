import { appendChange, ensureChangeFeedTable } from '@happyvertical/smrt-core';

/**
 * Change-feed bumps for the site's raw SQL writers (issues #436, #459).
 *
 * SMRT's change feed is fed by the `save()`/`delete()` interceptor, so every
 * write that goes around the collection — the inactive-source sweep, the board
 * reconciler's batched re-stamp/absence/revive statements, the source-content
 * fingerprint backfill, and the two intelligence-status writers — is invisible
 * to it. A mounted admin list polling `_changes` therefore stayed on its old
 * cursor and showed stale rows until a reload. `bumpChangeFeed` is the
 * framework's documented escape hatch for exactly this; this module is the one
 * place the site calls it, so every raw writer records the same way.
 *
 * A bump is bookkeeping, not the write: it runs after the statement succeeded
 * and must never un-succeed it, so a failure here is swallowed and reported
 * through the return value rather than thrown. That mirrors the framework
 * interceptor's own failure policy.
 *
 * These bumps call `appendChange` rather than `bumpChangeFeed` (issue #458).
 * `bumpChangeFeed` is `ensureChangeFeedTable` followed by `appendChange`, and
 * the ensure is memoized on a per-handle `WeakSet`. A bump inside a
 * transaction gets a fresh transaction-scoped handle every time, so the ensure
 * was never warm there: on the first bump after a deploy or a migration that
 * changed the feed schema it would run `CREATE TABLE`/`CREATE FUNCTION` DDL
 * *inside* the caller's transaction. smrt-core 0.44.1 wraps `appendChange`
 * itself in a PL/pgSQL subtransaction (smrt#2026) so an append error cannot
 * abort the caller, but the ensure sits outside that protection.
 *
 * `appendChange` issues no DDL, so the table has to exist before the first
 * bump. {@link ensureChangeFeedTableOnce} is the one place that creates it, and
 * `db-migrate` runs it alongside the other schema guards.
 *
 * The mechanics are the same whatever table the raw statement hit, so
 * {@link bumpRowChangeFeed} holds them once and the per-table helpers below
 * name the table. `tasks` is live-subscribed the same way `opportunities` is
 * (issue #459), so auto-archive's task closure records through here rather than
 * through a copy of this logic.
 */

/** Physical table every opportunity write lands in. */
export const OPPORTUNITY_TABLE = 'opportunities';

/** Physical table every task write lands in. */
export const TASK_TABLE = 'tasks';

/**
 * Above this many rows a per-row bump costs more than it is worth, so one
 * table-level entry is recorded instead. Consumers read a `rowId: null` entry
 * as "anything in this table may have changed", which is exactly right for a
 * bulk archive.
 */
export const MAX_PER_ROW_CHANGE_BUMPS = 100;

type ChangeFeedDatabase = Parameters<typeof appendChange>[0];

/**
 * Create the change-feed table and its append function if they are absent.
 *
 * Call this once against a long-lived handle — `db-migrate` does, next to the
 * other `ensure*` schema guards — never from inside a transaction that is doing
 * real work. Everything else assumes the feed exists and only appends.
 */
export async function ensureChangeFeedTableOnce(
  database: unknown,
): Promise<void> {
  await ensureChangeFeedTable(database as ChangeFeedDatabase);
}

/**
 * Record that a raw statement changed these rows of `table`.
 *
 * Pass the ids the statement actually returned, never the ids it was asked to
 * match: a bump for a row that did not change would make every poller refetch
 * for nothing. An empty list records nothing.
 *
 * @returns The number of entries appended (a table-level bump counts as one).
 */
export async function bumpRowChangeFeed(
  database: unknown,
  table: string,
  rowIds: Iterable<string>,
): Promise<number> {
  const ids = [
    ...new Set(
      [...rowIds]
        .map((id) => (typeof id === 'string' ? id.trim() : String(id ?? '')))
        .filter((id) => id.length > 0),
    ),
  ];
  if (ids.length === 0) return 0;
  const db = database as ChangeFeedDatabase;
  try {
    if (ids.length > MAX_PER_ROW_CHANGE_BUMPS) {
      await appendChange(db, { operation: 'update', rowId: null, table });
      return 1;
    }
    for (const rowId of ids) {
      await appendChange(db, { operation: 'update', rowId, table });
    }
    return ids.length;
  } catch {
    // Swallowing keeps a bump from un-succeeding the statement it describes.
    // Note the limit: if the append itself failed at the statement level —
    // `_smrt_append_change` absent because `db:migrate` never ran — PostgreSQL
    // has already marked the caller's transaction aborted, and swallowing here
    // does not undo that. `db-migrate` creating the feed is what keeps this to
    // the intended case: a missed bump costs a stale list, never a lost row.
    return 0;
  }
}

/**
 * Record that a raw statement changed an unknown set of rows in `table`.
 *
 * Use this only where the statement cannot return the affected ids (a plain
 * row count). One table-level entry tells consumers to re-read the table.
 */
export async function bumpTableChangeFeed(
  database: unknown,
  table: string,
  changedRows: number,
): Promise<number> {
  if (!Number.isFinite(changedRows) || changedRows <= 0) return 0;
  try {
    await appendChange(database as ChangeFeedDatabase, {
      operation: 'update',
      rowId: null,
      table,
    });
    return 1;
  } catch {
    return 0;
  }
}

/** Record that a raw statement changed these opportunities. */
export async function bumpOpportunityChangeFeed(
  database: unknown,
  opportunityIds: Iterable<string>,
): Promise<number> {
  return await bumpRowChangeFeed(database, OPPORTUNITY_TABLE, opportunityIds);
}

/** Record that a raw statement changed an unknown set of opportunities. */
export async function bumpOpportunityTableChangeFeed(
  database: unknown,
  changedRows: number,
): Promise<number> {
  return await bumpTableChangeFeed(database, OPPORTUNITY_TABLE, changedRows);
}

/**
 * Record that a raw statement changed these tasks.
 *
 * Auto-archive closes review tasks with a raw `UPDATE tasks` (issue #459), and
 * `tasks` is live-subscribed, so without this a mounted list keeps showing
 * review work against a posting the board has stopped listing.
 */
export async function bumpTaskChangeFeed(
  database: unknown,
  taskIds: Iterable<string>,
): Promise<number> {
  return await bumpRowChangeFeed(database, TASK_TABLE, taskIds);
}
