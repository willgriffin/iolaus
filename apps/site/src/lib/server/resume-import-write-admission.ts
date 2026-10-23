import { randomUUID } from 'node:crypto';
import { detectEngine } from '@happyvertical/smrt-core';
import type {
  AccountDeletionDatabase,
  AccountDeletionDialect,
  AccountDeletionScope,
} from './account-deletion.js';

type Row = Record<string, unknown>;
function rows(result: { rows?: Row[] } | Row[]): Row[] {
  return Array.isArray(result) ? result : (result.rows ?? []);
}

/** Must be called on the native transaction executor, before any other read.
 * SQLite's no-op write obtains its native writer lock (not a JS-only fence).
 * PostgreSQL locks the extant stable account row, independently of advisory pins.
 */
export async function lockResumeImportAccount(
  tx: AccountDeletionDatabase,
  scope: AccountDeletionScope,
  dialect: AccountDeletionDialect,
): Promise<void> {
  if (dialect === 'sqlite')
    await tx.query('UPDATE users SET id = id WHERE id = ?', [scope.userId]);
  else
    await tx.query('SELECT id FROM users WHERE id = ? FOR UPDATE', [
      scope.userId,
    ]);
}

export async function pendingResumeImportWrites(
  tx: AccountDeletionDatabase,
  scope: AccountDeletionScope,
): Promise<number> {
  const found = rows(
    await tx.query(
      'SELECT COUNT(*) AS n FROM resume_import_write_operations WHERE tenant_id = ? AND user_id = ?',
      [scope.tenantId, scope.userId],
    ),
  );
  const count = Number(found[0]?.n);
  if (!Number.isSafeInteger(count) || count < 0)
    throw new Error('Cannot prove private source writes have settled.');
  return count;
}

/** A new random id per invocation: request/delivery deduplication is not drain proof. */
export async function beginResumeImportWrite(
  db: AccountDeletionDatabase,
  scope: AccountDeletionScope & { profileId: string },
  locator: { sourceId: string; deliveryKey: string },
): Promise<string> {
  if (!db.transaction)
    throw new Error('Private source writes require transactional storage.');
  const id = randomUUID();
  await db.transaction(async (tx) => {
    await lockResumeImportAccount(
      tx,
      scope,
      detectEngine(db.url) === 'sqlite' ? 'sqlite' : 'postgres',
    );
    const account = rows(
      await tx.query(
        `SELECT u.id FROM users u JOIN memberships m ON m.user_id = u.id
        JOIN tenants t ON t.id = m.tenant_id
       WHERE u.id = ? AND u.profile_id = ? AND m.tenant_id = ?
         AND u.status = 'active' AND m.status = 'active' AND t.status = 'active'`,
        [scope.userId, scope.profileId, scope.tenantId],
      ),
    );
    const closed = rows(
      await tx.query(
        "SELECT id FROM account_deletion_records WHERE tenant_id = ? AND user_id = ? AND status = 'started' LIMIT 1",
        [scope.tenantId, scope.userId],
      ),
    );
    if (!account.length || closed.length)
      throw new Error(
        'Account is unavailable or deletion has started; resume upload is unavailable.',
      );
    await tx.query(
      `INSERT INTO resume_import_write_operations
        (id, slug, context, tenant_id, user_id, profile_id, source_id, delivery_key, created_at, updated_at)
       VALUES (?, ?, 'resume-import-write', ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
      [
        id,
        id,
        scope.tenantId,
        scope.userId,
        scope.profileId,
        locator.sourceId,
        locator.deliveryKey,
      ],
    );
  });
  return id;
}

/** No finally/timeout/retry caller may use this as evidence of settlement. */
export async function resolveResumeImportWrite(
  db: AccountDeletionDatabase,
  scope: AccountDeletionScope,
  id: string,
): Promise<void> {
  const predicate = 'id = ? AND tenant_id = ? AND user_id = ?';
  const values = [id, scope.tenantId, scope.userId];
  const found = rows(
    await db.query(
      `SELECT id FROM resume_import_write_operations WHERE ${predicate}`,
      values,
    ),
  );
  if (found.length !== 1)
    throw new Error('Private source write marker is unavailable.');
  await db.query(
    `DELETE FROM resume_import_write_operations WHERE ${predicate}`,
    values,
  );
}
