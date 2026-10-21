import { createHash } from 'node:crypto';
import { detectEngine } from '@happyvertical/smrt-core';
import type { DatabaseInterface } from '@happyvertical/sql';
import { withSqliteOperationLock } from './sqlite-operation-lock.js';

type AccountScope = { tenantId: string; userId: string };

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
  const session = await db.acquireSession();
  let locked = false;
  try {
    await session.query("SET lock_timeout = '15s'");
    await session.query('SELECT pg_advisory_lock(hashtext($1))', [key]);
    locked = true;
    return await action();
  } finally {
    try {
      if (locked)
        await session.query('SELECT pg_advisory_unlock(hashtext($1))', [key]);
      await session.query('RESET lock_timeout');
    } finally {
      await session.release();
    }
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
