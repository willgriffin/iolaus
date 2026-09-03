import { randomUUID } from 'node:crypto';
import {
  appendChange,
  ensureChangeFeedTable,
  resolveDatabase,
} from '@happyvertical/smrt-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * Issue #457 — the deadlock cycle between the reconciliation transaction and
 * the change feed.
 *
 * #433 put the whole board reconciliation in one transaction; #436 appends to
 * the change feed inside it. The feed serializes its sequence
 * (`COALESCE(MAX(seq), 0) + 1`), so an append blocks behind any uncommitted
 * append. That gives two transactions a genuine lock cycle:
 *
 * 1. the crawl takes row locks on opportunities, then appends;
 * 2. an owner request appends, then touches one of those rows.
 *
 * Each then waits on the other. PostgreSQL detects it (`40P01`) and aborts one
 * side, so the crawl fails closed — but the crawl is lost and retried, and the
 * risk is new.
 *
 * This spec drives the cycle deterministically on two connections. It runs
 * only against an explicitly named throwaway database, never the dev mirror:
 *
 * ```
 * createdb change_feed_deadlock_test
 * CHANGE_FEED_DEADLOCK_TEST_DATABASE_URL=postgresql://…/change_feed_deadlock_test \
 *   pnpm --filter @willgriffin/iolaus-site exec vitest run \
 *   src/lib/server/change-feed-deadlock.integration.spec.ts
 * ```
 */

const databaseUrl =
  process.env.CHANGE_FEED_DEADLOCK_TEST_DATABASE_URL?.trim() ?? '';
const enabled = Boolean(databaseUrl);

const ROW_ID = '44444444-4444-4444-8444-444444444444';
const OTHER_ROW_ID = '55555555-5555-4555-8555-555555555555';

type Handle = Awaited<ReturnType<typeof resolveDatabase>>;

/** Resolve on its own `dbid` so each side gets an independent connection. */
async function connect(label: string): Promise<Handle> {
  return await resolveDatabase(
    { type: 'postgres', url: databaseUrl },
    { dbid: `change-feed-deadlock-${label}-${randomUUID()}` },
  );
}

/** `transaction` is optional on the handle type; postgres always has it. */
function runTransaction(
  handle: Handle,
  run: (tx: Handle) => Promise<void>,
): Promise<unknown> {
  const transaction = handle.transaction;
  if (typeof transaction !== 'function') {
    throw new Error('This spec requires a transactional postgres handle.');
  }
  return transaction.call(handle, run as never);
}

function deferred<T>(): {
  promise: Promise<T>;
  reject: (reason: unknown) => void;
  resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, reject, resolve };
}

/** Wait until `pg_stat_activity` shows this connection blocked on a lock. */
async function waitUntilBlocked(observer: Handle, sql: string): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const result = await observer.query(
      `SELECT count(*)::int AS blocked
         FROM pg_stat_activity
        WHERE wait_event_type = 'Lock'
          AND query LIKE $1`,
      `%${sql}%`,
    );
    const rows = Array.isArray(result?.rows) ? result.rows : [];
    if (Number(rows[0]?.blocked ?? 0) > 0) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out waiting for a connection blocked on: ${sql}`);
}

function isDeadlock(error: unknown): boolean {
  const code = (error as { code?: unknown })?.code;
  if (String(code) === '40P01') return true;
  return /deadlock detected/i.test(String((error as Error)?.message ?? ''));
}

describe.runIf(enabled)('change-feed deadlock cycle (issue #457)', () => {
  let setup: Handle;
  let crawl: Handle;
  let owner: Handle;
  let observer: Handle;

  beforeAll(async () => {
    const parsed = new URL(databaseUrl);
    const name = parsed.pathname.replace(/^\/+/, '');
    if (
      !['localhost', '127.0.0.1', '::1'].includes(parsed.hostname) ||
      !name.includes('deadlock_test')
    ) {
      throw new Error(
        'This spec mutates rows and must only run against a local database named with deadlock_test.',
      );
    }
    setup = await connect('setup');
    await setup.query('DROP TABLE IF EXISTS opportunities CASCADE');
    await setup.query(`
      CREATE TABLE opportunities (
        id UUID PRIMARY KEY,
        status TEXT NOT NULL DEFAULT 'found',
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )`);
    for (const id of [ROW_ID, OTHER_ROW_ID]) {
      await setup.query(
        'INSERT INTO opportunities (id, status) VALUES ($1, $2)',
        id,
        'found',
      );
    }
    // The real feed schema, including the PL/pgSQL append boundary.
    await ensureChangeFeedTable(setup);
    crawl = await connect('crawl');
    owner = await connect('owner');
    observer = await connect('observer');
  }, 60_000);

  afterAll(async () => {
    await setup?.query('DROP TABLE IF EXISTS opportunities CASCADE');
  });

  it('deadlocks when the crawl appends while holding opportunity row locks', async () => {
    const crawlHoldsRowLock = deferred<void>();
    const ownerHoldsSeq = deferred<void>();
    const ownerFinished = deferred<'ok' | 'deadlock'>();
    const crawlFinished = deferred<'ok' | 'deadlock'>();

    // The crawl transaction: row locks first (#433), then the feed append
    // (#436).
    const crawlSide = runTransaction(crawl, async (tx) => {
      await tx.query(
        "UPDATE opportunities SET updated_at = now(), status = 'stale' WHERE id = $1",
        ROW_ID,
      );
      crawlHoldsRowLock.resolve();
      await ownerHoldsSeq.promise;
      // The owner is now blocked on our row lock; this append wants the seq
      // the owner already holds uncommitted. That closes the cycle.
      await appendChange(tx, {
        operation: 'update',
        rowId: ROW_ID,
        table: 'opportunities',
      });
    })
      .then(() => 'ok' as const)
      .catch((error) => {
        if (isDeadlock(error)) return 'deadlock' as const;
        throw error;
      })
      .then((outcome) => {
        crawlFinished.resolve(outcome);
        return outcome;
      });

    // The owner request: the change-feed interceptor appends, then the write
    // touches the same row the crawl is holding.
    const ownerSide = runTransaction(owner, async (tx) => {
      await crawlHoldsRowLock.promise;
      await appendChange(tx, {
        operation: 'update',
        rowId: ROW_ID,
        table: 'opportunities',
      });
      ownerHoldsSeq.resolve();
      await tx.query(
        "UPDATE opportunities SET status = 'recommended' WHERE id = $1",
        ROW_ID,
      );
    })
      .then(() => 'ok' as const)
      .catch((error) => {
        if (isDeadlock(error)) return 'deadlock' as const;
        throw error;
      })
      .then((outcome) => {
        ownerFinished.resolve(outcome);
        return outcome;
      });

    await crawlHoldsRowLock.promise;
    await ownerHoldsSeq.promise;
    await waitUntilBlocked(observer, 'UPDATE opportunities SET status');

    const outcomes = await Promise.all([crawlSide, ownerSide]);

    // PostgreSQL aborts exactly one side of a genuine cycle.
    expect(outcomes).toContain('deadlock');
  }, 60_000);

  /**
   * The issue lists "take feed and row locks in a consistent order" as an
   * option. This case shows that ordering is not the problem, so ordering
   * cannot be the fix.
   *
   * Both sides here use the order the framework's own `save()` produces —
   * write the row, then let the change-feed interceptor append. The cycle
   * still forms, because the reconciliation transaction is long: it keeps
   * acquiring row locks *after* it has appended, so a second writer that
   * appended first is already waiting behind it.
   */
  it('still deadlocks when both sides write the row before appending', async () => {
    const crawlLockedFirstRow = deferred<void>();
    const ownerLockedSecondRow = deferred<void>();
    const crawlAppended = deferred<void>();

    const crawlSide = runTransaction(crawl, async (tx) => {
      await tx.query(
        "UPDATE opportunities SET status = 'stale' WHERE id = $1",
        ROW_ID,
      );
      crawlLockedFirstRow.resolve();
      await ownerLockedSecondRow.promise;
      await appendChange(tx, {
        operation: 'update',
        rowId: ROW_ID,
        table: 'opportunities',
      });
      crawlAppended.resolve();
      // A later statement in the same reconciliation reaches a row the other
      // writer already holds.
      await tx.query(
        "UPDATE opportunities SET status = 'archived' WHERE id = $1",
        OTHER_ROW_ID,
      );
    })
      .then(() => 'ok' as const)
      .catch((error) => {
        if (isDeadlock(error)) return 'deadlock' as const;
        throw error;
      });

    const ownerSide = runTransaction(owner, async (tx) => {
      await crawlLockedFirstRow.promise;
      await tx.query(
        "UPDATE opportunities SET status = 'recommended' WHERE id = $1",
        OTHER_ROW_ID,
      );
      ownerLockedSecondRow.resolve();
      await crawlAppended.promise;
      await appendChange(tx, {
        operation: 'update',
        rowId: OTHER_ROW_ID,
        table: 'opportunities',
      });
    })
      .then(() => 'ok' as const)
      .catch((error) => {
        if (isDeadlock(error)) return 'deadlock' as const;
        throw error;
      });

    const outcomes = await Promise.all([crawlSide, ownerSide]);

    expect(outcomes).toContain('deadlock');
  }, 60_000);
});
