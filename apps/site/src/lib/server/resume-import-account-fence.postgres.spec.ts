import { randomUUID } from 'node:crypto';
import { getDatabase } from '@happyvertical/sql';
import { describe, expect, it } from 'vitest';
import {
  ResumeImportLifecycleBusyError,
  withResumeImportAccountFence,
} from './resume-import-account-fence.js';

const url = process.env.RESUME_IMPORT_POSTGRES_TEST_DATABASE_URL?.trim();
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
async function nativeDatabase(max = 5, timeout = 1_000) {
  if (!url || new URL(url).pathname !== '/iolaus_resume_import_qa')
    throw new Error(
      'Use the isolated iolaus_resume_import_qa control database.',
    );
  return await getDatabase({
    cache: false,
    type: 'postgres',
    url,
    max,
    connectionTimeoutMillis: timeout,
  });
}
const scope = () => ({ tenantId: randomUUID(), userId: randomUUID() });

describe.runIf(url)('native PostgreSQL lifecycle capacity', () => {
  it('leaves CRUD capacity with two pins and two nested native transactions', async () => {
    const db = await nativeDatabase();
    const transaction = db.transaction;
    if (!transaction) throw new Error('Native transactions required');
    const hold = deferred();
    const bothEntered = deferred();
    let entered = 0;
    const operations = [0, 1].map(() =>
      withResumeImportAccountFence({ ...db }, scope(), async () => {
        await transaction(async (transaction) => {
          await transaction.query('SELECT 1');
          // Native nested transactions use a SAVEPOINT on this executor.
          if (!transaction.transaction)
            throw new Error('Nested native transactions required');
          await transaction.transaction(async (nested) => {
            await nested.query('SELECT 1');
          });
          if (++entered === 2) bothEntered.resolve();
          await hold.promise;
        });
      }),
    );
    const completion = Promise.all(operations);
    // Attach a rejection handler before waiting at the barrier.
    void completion.catch(() => bothEntered.resolve());
    try {
      await bothEntered.promise;
      expect(entered).toBe(2);
      expect((await db.query('SELECT 1 AS available')).rows[0].available).toBe(
        1,
      );
      await expect(
        withResumeImportAccountFence(db, scope(), async () => {}),
      ).rejects.toBeInstanceOf(ResumeImportLifecycleBusyError);
    } finally {
      hold.resolve();
      await completion.finally(() => db.close?.());
    }
  }, 10_000);

  it('native full-pool acquisition times out without a late abandoned checkout', async () => {
    const db = await nativeDatabase(3, 100);
    const acquireSession = db.acquireSession;
    if (!acquireSession) throw new Error('Native sessions required');
    const holders = await Promise.all(
      Array.from({ length: 3 }, () => acquireSession()),
    );
    try {
      const action = () => {
        throw new Error('Action must never run');
      };
      await expect(
        withResumeImportAccountFence(db, scope(), action),
      ).rejects.toBeInstanceOf(ResumeImportLifecycleBusyError);
      const pool = db.client as {
        waitingCount: number;
        totalCount: number;
        idleCount: number;
      };
      expect(pool.waitingCount).toBe(0);
      await Promise.all(holders.map((holder) => holder.release()));
      // Checkout after releasing holders proves the timed-out waiter cannot
      // acquire a late client. Every new holder is released explicitly.
      const retries = await Promise.all(
        Array.from({ length: 3 }, () => acquireSession()),
      );
      expect(pool.waitingCount).toBe(0);
      await Promise.all(retries.map((session) => session.release()));
      expect(pool.totalCount - pool.idleCount).toBe(0);
      await expect(
        withResumeImportAccountFence(db, scope(), async () => 'retry'),
      ).resolves.toBe('retry');
    } finally {
      await Promise.all(holders.map((holder) => holder.release()));
      await db.close?.();
    }
  }, 10_000);

  it('keeps the cross-handle advisory lock for the same owner', async () => {
    const first = await nativeDatabase();
    const second = await nativeDatabase();
    const owner = scope();
    const entered = deferred();
    const hold = deferred();
    let deletionEntered = false;
    const receive = withResumeImportAccountFence(first, owner, async () => {
      entered.resolve();
      await hold.promise;
    });
    // Release the observation barrier on setup failure as well, so the test
    // reaches cleanup instead of waiting forever for an action that cannot run.
    void receive.catch(() => entered.resolve());
    await entered.promise;
    const deleting = withResumeImportAccountFence(second, owner, async () => {
      deletionEntered = true;
    });
    void deleting.catch(() => {});
    try {
      // Observe the real server lock wait, not just a scheduling delay.
      let waiting = false;
      for (let attempt = 0; attempt < 100; attempt++) {
        const result = await first.query(
          "SELECT 1 FROM pg_locks WHERE locktype = 'advisory' AND granted = false AND database = (SELECT oid FROM pg_database WHERE datname = current_database())",
        );
        if (result.rows.length) {
          waiting = true;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(waiting).toBe(true);
      expect(deletionEntered).toBe(false);
    } finally {
      hold.resolve();
      await Promise.all([receive, deleting]).finally(() =>
        Promise.all([first.close?.(), second.close?.()]),
      );
    }
    expect(deletionEntered).toBe(true);
  }, 10_000);
});
