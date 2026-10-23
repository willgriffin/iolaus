import type { DatabaseInterface } from '@happyvertical/sql';
import { describe, expect, it, vi } from 'vitest';
import {
  assertResumeImportAccountNotDeleting,
  ResumeImportLifecycleBusyError,
  withResumeImportAccountFence,
} from './resume-import-account-fence.js';

const scope = { tenantId: 'tenant', userId: 'owner' };
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function database(max = 5) {
  const query = vi.fn(async (_sql: string) => ({ rows: [], rowCount: 0 }));
  const release = vi.fn(async () => {});
  const acquireSession = vi.fn(async () => ({
    query,
    release,
    isActive: () => true,
  }));
  const db = {
    url: 'postgresql://example.invalid/test',
    client: { options: { max } },
    acquireSession,
  } as unknown as DatabaseInterface;
  return { db, acquireSession, query, release };
}

describe('resume lifecycle pool admission', () => {
  it.each([
    [1, 0],
    [2, 0],
    [3, 1],
    [4, 1],
    [5, 2],
    [20, 2],
  ])('bounds max %i to %i actions without queueing acquisition', async (max, limit) => {
    const { db, acquireSession } = database(max);
    const hold = deferred();
    const actions = Array.from({ length: limit }, (_, index) =>
      withResumeImportAccountFence(
        db,
        { ...scope, userId: `owner-${index}` },
        () => hold.promise,
      ),
    );
    const excessAction = vi.fn();
    try {
      await expect(
        withResumeImportAccountFence(db, scope, excessAction),
      ).rejects.toMatchObject({ status: 503 });
      expect(acquireSession).toHaveBeenCalledTimes(limit);
      expect(excessAction).not.toHaveBeenCalled();
    } finally {
      hold.resolve();
      await Promise.all(actions);
    }
  });

  it('shares admission across receive/deletion request wrappers and distinct owners progress together', async () => {
    const { db, acquireSession } = database();
    const hold = deferred();
    const entered = vi.fn(async () => {
      await hold.promise;
    });
    const receives = [0, 1].map((index) =>
      withResumeImportAccountFence(
        { ...db },
        { ...scope, userId: `owner-${index}` },
        entered,
      ),
    );
    try {
      await vi.waitFor(() => expect(entered).toHaveBeenCalledTimes(2));
      await expect(
        withResumeImportAccountFence({ ...db }, scope, async () => {}),
      ).rejects.toBeInstanceOf(ResumeImportLifecycleBusyError);
      expect(acquireSession).toHaveBeenCalledTimes(2);
    } finally {
      hold.resolve();
      await Promise.all(receives);
    }
    await expect(
      withResumeImportAccountFence(db, scope, async () => 'deleted'),
    ).resolves.toBe('deleted');
  });

  it('counts pending acquisition before any asynchronous boundary', async () => {
    const { db, acquireSession } = database(3);
    const acquired = deferred();
    acquireSession.mockImplementationOnce(async () => {
      await acquired.promise;
      throw new Error('provider-secret');
    });
    const pending = withResumeImportAccountFence(db, scope, async () => {});
    const rejection = expect(pending).rejects.toBeInstanceOf(
      ResumeImportLifecycleBusyError,
    );
    try {
      await expect(
        withResumeImportAccountFence({ ...db }, scope, async () => {}),
      ).rejects.toBeInstanceOf(ResumeImportLifecycleBusyError);
      expect(acquireSession).toHaveBeenCalledTimes(1);
    } finally {
      acquired.resolve();
      await rejection;
    }
    await expect(
      withResumeImportAccountFence(db, scope, async () => 'retry'),
    ).resolves.toBe('retry');
  });

  it.each([
    'lock',
    'action',
    'unlock',
    'release',
  ])('reclaims admission after %s failure without mislabeling action/cleanup failures', async (phase) => {
    const { db, query, release } = database(3);
    const fault = new Error('provider-secret');
    const action = vi.fn(async () => {
      if (phase === 'action') throw fault;
      return 'ok';
    });
    query.mockImplementation(async (sql) => {
      if (
        (phase === 'lock' && sql.includes('pg_advisory_lock(')) ||
        (phase === 'unlock' && sql.includes('pg_advisory_unlock('))
      )
        throw fault;
      return { rows: [], rowCount: 0 };
    });
    if (phase === 'release') release.mockRejectedValueOnce(fault);
    const operation = withResumeImportAccountFence(db, scope, action);
    await expect(operation).rejects.toBeInstanceOf(
      phase === 'lock' ? ResumeImportLifecycleBusyError : Error,
    );
    if (phase === 'lock') expect(action).not.toHaveBeenCalled();
    else await expect(operation).rejects.toBe(fault);
    expect(release).toHaveBeenCalledTimes(1);
    query.mockResolvedValue({ rows: [], rowCount: 0 });
    await expect(
      withResumeImportAccountFence(db, scope, async () => 'retry'),
    ).resolves.toBe('retry');
  });

  it('counts account advisory lock waiters against admission', async () => {
    const { db, acquireSession, query } = database(3);
    const hold = deferred();
    const entered = deferred();
    query.mockImplementationOnce(async () => ({ rows: [], rowCount: 0 }));
    query.mockImplementationOnce(async () => {
      entered.resolve();
      await hold.promise;
      return { rows: [], rowCount: 0 };
    });
    const waiting = withResumeImportAccountFence(db, scope, async () => {});
    try {
      await entered.promise;
      await expect(
        withResumeImportAccountFence({ ...db }, scope, async () => {}),
      ).rejects.toBeInstanceOf(ResumeImportLifecycleBusyError);
      expect(acquireSession).toHaveBeenCalledTimes(1);
    } finally {
      hold.resolve();
      await waiting;
    }
  });

  it('holds admission until session release completes', async () => {
    const { db, release } = database(3);
    const cleanup = deferred();
    release.mockImplementationOnce(() => cleanup.promise);
    const operation = withResumeImportAccountFence(db, scope, async () => {});
    try {
      await vi.waitFor(() => expect(release).toHaveBeenCalledTimes(1));
      await expect(
        withResumeImportAccountFence(db, scope, async () => {}),
      ).rejects.toBeInstanceOf(ResumeImportLifecycleBusyError);
    } finally {
      cleanup.resolve();
      await operation;
    }
    await expect(
      withResumeImportAccountFence(db, scope, async () => 'retry'),
    ).resolves.toBe('retry');
  });

  it('preserves the action error when cleanup also fails', async () => {
    const { db, release } = database(3);
    release.mockRejectedValueOnce(new Error('cleanup'));
    const fault = new Error('partial action');
    await expect(
      withResumeImportAccountFence(db, scope, async () => {
        throw fault;
      }),
    ).rejects.toBe(fault);
  });

  it('refuses bytes for a started, resumable deletion', async () => {
    const query = vi.fn(async () => ({ rows: [{ id: 'failed-deletion' }] }));
    await expect(
      assertResumeImportAccountNotDeleting(
        { query } as unknown as DatabaseInterface,
        scope,
      ),
    ).rejects.toThrow('Account deletion has started');
    expect(query).toHaveBeenCalledWith(
      expect.stringContaining("status = 'started'"),
      ['tenant', 'owner'],
    );
  });
});
