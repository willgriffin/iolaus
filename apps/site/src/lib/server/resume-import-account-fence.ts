import { createHash } from 'node:crypto';
import { detectEngine } from '@happyvertical/smrt-core';
import type { DatabaseInterface, SessionHandle } from '@happyvertical/sql';
import { withSqliteOperationLock } from './sqlite-operation-lock.js';

type AccountScope = { tenantId: string; userId: string };

/** A refusal before the lifecycle action starts; retrying is safe. */
export class ResumeImportLifecycleBusyError extends Error {
  readonly code = 'resume_lifecycle_busy';
  readonly status = 503;
  constructor(
    message = 'Account lifecycle capacity is busy. Wait briefly and try again.',
  ) {
    super(message);
    this.name = 'ResumeImportLifecycleBusyError';
  }
}

// Database wrappers share the adapter's actual client (the pg Pool), rather
// than their request-local object identity. Never key this by account or URL.
const admittedByPool = new WeakMap<object, number>();

/** Drain in-flight receives before deletion enumerates private source assets. */
export async function withResumeImportAccountFence<T>(
  db: DatabaseInterface,
  scope: AccountScope,
  action: () => Promise<T>,
): Promise<T> {
  const key = `resume-import:${createHash('sha256')
    .update(JSON.stringify([scope.tenantId, scope.userId]))
    .digest('hex')}`;
  if (detectEngine(db.url) === 'sqlite')
    return await withSqliteOperationLock(key, action);
  if (typeof db.acquireSession !== 'function')
    throw new Error(
      'Resume import lifecycle requires a pinned database session.',
    );
  const pool = db.client as { options?: { max?: number } } | undefined;
  const max = pool?.options?.max;
  if (!pool || typeof max !== 'number' || !Number.isInteger(max) || max < 1)
    throw new Error(
      'Resume import lifecycle requires a bounded PostgreSQL pool.',
    );
  // One pin + one native transaction per action; reserve one CRUD connection.
  const limit = Math.min(2, Math.floor((max - 1) / 2));
  const admitted = admittedByPool.get(pool) ?? 0;
  if (!limit)
    throw new ResumeImportLifecycleBusyError(
      'Account lifecycle requires at least three database connections. Ask the operator to configure the shared pool.',
    );
  if (admitted >= limit) throw new ResumeImportLifecycleBusyError();
  // Synchronous nonqueued admission includes acquisition, lock wait and cleanup.
  admittedByPool.set(pool, admitted + 1);
  try {
    let session: SessionHandle;
    try {
      session = await db.acquireSession();
    } catch {
      throw new ResumeImportLifecycleBusyError();
    }
    let locked = false;
    let failure: { error: unknown } | undefined;
    let result: T | undefined;
    try {
      try {
        await session.query("SET lock_timeout = '15s'");
        await session.query('SELECT pg_advisory_lock(hashtext($1))', [key]);
        locked = true;
      } catch {
        throw new ResumeImportLifecycleBusyError();
      }
      // Errors after this point may follow committed writes: never label busy.
      result = await action();
    } catch (error) {
      failure = { error };
    }
    try {
      try {
        if (locked)
          await session.query('SELECT pg_advisory_unlock(hashtext($1))', [key]);
        await session.query('RESET lock_timeout');
      } finally {
        await session.release();
      }
    } catch (error) {
      // Preserve the original action/refusal when cleanup also fails.
      failure ??= { error };
    }
    if (failure) throw failure.error;
    return result as T;
  } finally {
    const remaining = (admittedByPool.get(pool) ?? 1) - 1;
    if (remaining) admittedByPool.set(pool, remaining);
    else admittedByPool.delete(pool);
  }
}

/** A failed, resumable deletion still forbids accepting new private bytes. */
export async function assertResumeImportAccountNotDeleting(
  db: DatabaseInterface,
  scope: AccountScope,
): Promise<void> {
  const result = await db.query(
    "SELECT id FROM account_deletion_records WHERE tenant_id = ? AND user_id = ? AND status = 'started' LIMIT 1",
    [scope.tenantId, scope.userId],
  );
  if (result.rows.length)
    throw new Error(
      'Account deletion has started; resume upload is unavailable.',
    );
}
