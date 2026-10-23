import { createHash, randomUUID } from 'node:crypto';
import type {
  FilesystemInterface,
  GetFilesystemOptions,
} from '@happyvertical/files';
import type { AssetStoreOptions } from '@happyvertical/smrt-assets';
import {
  getFilesystemLazy,
  isFileNotFoundError,
} from '@happyvertical/smrt-assets';
import type { DatabaseInterface } from '@happyvertical/sql';
import { pendingResumeImportWrites } from './resume-import-write-admission.js';

type Db = Pick<DatabaseInterface, 'query'>;
type Row = Record<string, unknown>;
type Request = Parameters<NonNullable<AssetStoreOptions['resolver']>>[0];
export const RESUME_ORIGINAL_RECOVERY_MS = 30 * 24 * 60 * 60 * 1000;
const unavailable = () => new Error('Private resume original is unavailable.');
function value(value: unknown): string {
  if (
    typeof value !== 'string' ||
    !value.trim() ||
    value !== value.trim() ||
    value.length > 1024 ||
    /[\p{Cc}\p{Cf}]/u.test(value)
  )
    throw unavailable();
  return value;
}
function instant(value: unknown): Date {
  // SQLite's CURRENT_TIMESTAMP is UTC even though it has no zone suffix.
  const text =
    typeof value === 'string' && /^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d$/.test(value)
      ? `${value.replace(' ', 'T')}Z`
      : value;
  const date = text instanceof Date ? text : new Date(String(text));
  if (!Number.isFinite(date.getTime())) throw unavailable();
  return date;
}
export function resumeStorageIdentity(storage: GetFilesystemOptions): string {
  if (storage.type === 's3') return `s3://${storage.bucket}/`;
  if (storage.type === 'local') return `file://${storage.basePath}/`;
  throw unavailable();
}
async function tombstone(
  db: Db,
  storage: string,
  key: string,
): Promise<Row | undefined> {
  return (
    await db.query(
      'SELECT * FROM resume_import_quarantines WHERE storage_identity = ? AND object_key = ?',
      [storage, key],
    )
  ).rows[0] as Row | undefined;
}
async function evidence(db: Db, request: Request): Promise<Row | undefined> {
  const rows = (
    await db.query(
      `SELECT e.*, i.visibility, i.expires_at AS item_expires_at, i.data AS item_data
    FROM intake_evidence e JOIN intake_items i ON i.id = e.item_id AND i.tenant_id = e.tenant_id
    WHERE e.asset_id = ?`,
      [request.asset.id],
    )
  ).rows as Row[];
  if (rows.length > 1) throw unavailable();
  const row = rows[0];
  if (row && row.tenant_id !== request.asset.tenantId) throw unavailable();
  if (row?.source_uri && row.source_uri !== request.sourceUri)
    throw unavailable();
  return row;
}
function owns(row: Row, request: Request): void {
  if (
    row.tenant_id !== request.asset.tenantId ||
    row.asset_id !== request.asset.id
  )
    throw unavailable();
}
async function active(
  db: Db,
  storage: string,
  key: string,
  request: Request,
): Promise<void> {
  if (await tombstone(db, storage, key)) throw unavailable();
  const row = await evidence(db, request);
  if (!row && /^intake\/[^/]+\.pdf$/.test(key)) throw unavailable();
  if (row && (row.visibility !== 'active' || row.state === 'revoked'))
    throw unavailable();
}

/** Native resolver hook: quarantine only root Resume.pdf evidence, before native
 * metadata removal/redaction. Every other evidence asset retains native deletion.
 */
export async function resolveQuarantinedResumeStorage(
  db: Db,
  storage: string,
  key: string,
  request: Request,
) {
  const existing = await tombstone(db, storage, key);
  if (existing) {
    owns(existing, request);
    if (request.operation !== 'delete') throw unavailable();
    return {
      filesystem: deletionOnlyFilesystem(request.defaultFilesystem),
      sourceUri: request.sourceUri,
    };
  }
  if (request.operation !== 'delete') {
    await active(db, storage, key, request);
    // Check again at actual I/O: planning is not permission to write later.
    const filesystem = new Proxy(request.defaultFilesystem, {
      get(target, name) {
        if (name === 'read' || name === 'write')
          return async (...args: unknown[]) => {
            await active(db, storage, key, request);
            const method = target[name] as (
              ...args: unknown[]
            ) => Promise<unknown>;
            const result = await method.apply(target, args);
            await active(db, storage, key, request);
            return result;
          };
        const member = Reflect.get(target, name, target);
        return typeof member === 'function' ? member.bind(target) : member;
      },
    });
    return { filesystem, sourceUri: request.sourceUri };
  }
  const row = await evidence(db, request);
  if (!row) {
    // A missing original's provenance cannot silently become a hard deletion.
    if (/^intake\/[^/]+\.pdf$/.test(key)) throw unavailable();
    return undefined;
  }
  if (
    row.parent_evidence_id ||
    row.part_id !== 'Resume.pdf' ||
    row.media_type !== 'application/pdf'
  )
    return undefined;
  owns(row, request);
  if (row.visibility !== 'expired' && row.visibility !== 'deleted')
    throw unavailable();
  const intent = (
    await db.query(
      'SELECT id, created_at FROM intake_deletions WHERE tenant_id = ? AND item_id = ?',
      [row.tenant_id, row.item_id],
    )
  ).rows[0] as Row | undefined;
  if (
    !intent ||
    !/^[a-f0-9]{64}$/.test(String(row.content_hash)) ||
    !Number.isSafeInteger(Number(row.byte_length)) ||
    Number(row.byte_length) < 1
  )
    throw unavailable();
  const data =
    typeof row.item_data === 'string'
      ? JSON.parse(row.item_data)
      : row.item_data;
  const userId = value(data?.capturedCeiling?.execution?.principalId);
  const deletionAt = instant(intent.created_at);
  // Native evidence access expires at the persisted expiry even if the sweeper
  // is delayed. Cleanup timing must not add recovery days to that deadline.
  const expiryAt =
    row.item_expires_at == null ? deletionAt : instant(row.item_expires_at);
  const revoked = new Date(Math.min(deletionAt.getTime(), expiryAt.getTime()));
  const id = randomUUID();
  await db.query(
    `INSERT INTO resume_import_quarantines
    (id, slug, context, storage_identity, object_key, tenant_id, user_id, profile_id,
     asset_id, item_id, deletion_id, content_hash, byte_length, revoked_at, purge_after, purge_attempts, created_at, updated_at)
    VALUES (?, ?, 'resume-original-quarantine', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    ON CONFLICT (storage_identity, object_key) DO NOTHING`,
    [
      id,
      id,
      storage,
      key,
      row.tenant_id,
      userId,
      row.confidential_scope_id,
      row.asset_id,
      row.item_id,
      intent.id,
      row.content_hash,
      Number(row.byte_length),
      revoked.toISOString(),
      new Date(revoked.getTime() + RESUME_ORIGINAL_RECOVERY_MS).toISOString(),
    ],
  );
  const committed = await tombstone(db, storage, key);
  if (!committed) throw unavailable();
  owns(committed, request);
  return {
    filesystem: deletionOnlyFilesystem(request.defaultFilesystem),
    sourceUri: request.sourceUri,
  };
}
function deletionOnlyFilesystem(
  filesystem: FilesystemInterface,
): FilesystemInterface {
  return new Proxy(filesystem, {
    get(_target, name) {
      if (name === 'delete') return async () => {};
      // The native deletion path may only acknowledge logical deletion.
      return () => {
        throw unavailable();
      };
    },
  });
}

/** No active profile join: revoked/deleted owners still receive retention cleanup.
 * Uncertain writers are swept but never reported physically settled. Tombstones
 * remain permanently, so delayed native repairs never create a second window.
 */
export async function purgeQuarantinedResumeOriginals(
  db: Db,
  storage: GetFilesystemOptions,
  options: { now?: Date; filesystem?: FilesystemInterface } = {},
): Promise<{ purged: number; pendingWrites: number; failed: number }> {
  const identity = resumeStorageIdentity(storage);
  const now = options.now ?? new Date();
  const rows = (
    await db.query(
      'SELECT * FROM resume_import_quarantines WHERE storage_identity = ? AND purged_at IS NULL AND purge_after <= ? ORDER BY COALESCE(purge_attempts, 0), purge_after, id LIMIT 200',
      [identity, now.toISOString()],
    )
  ).rows as Row[];
  const result = { purged: 0, pendingWrites: 0, failed: 0 };
  const filesystem = options.filesystem ?? (await getFilesystemLazy(storage));
  for (const row of rows) {
    try {
      // Commit this scheduling turn before any failure-prone marker/provider I/O.
      // A new sweep or restarted worker then reaches less-attempted due rows.
      // This never settles a writer, extends retention, or marks bytes purged.
      await db.query(
        'UPDATE resume_import_quarantines SET purge_attempts = COALESCE(purge_attempts, 0) + 1, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND purged_at IS NULL',
        [row.id],
      );
      if (instant(row.purge_after) > now) continue;
      const scope = {
        tenantId: value(row.tenant_id),
        userId: value(row.user_id),
      };
      const pending = await pendingResumeImportWrites(db, scope);
      try {
        await filesystem.delete(value(row.object_key));
      } catch (error) {
        if (!isFileNotFoundError(error)) throw error;
      }
      if (pending || (await pendingResumeImportWrites(db, scope))) {
        result.pendingWrites++;
        continue;
      }
      await db.query(
        'UPDATE resume_import_quarantines SET purged_at = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND purged_at IS NULL',
        [now.toISOString(), row.id],
      );
      result.purged++;
    } catch {
      result.failed++;
    }
  }
  return result;
}

export type ResumeOriginalRecoveryAuthority = {
  actorId: string;
  tenantId: string;
  destinationAuthority: string;
  reason: string;
};
/** Server/operator service only. Caller must explicitly authorize the named
 * actor, tenant, exact ledger identity and destination, including deleted owners.
 * Supply the root, independently committing database, never an encompassing
 * transaction executor. The audit commits before bytes are read, and checksum verification commits
 * before bytes are returned. No receipt/account state is modified.
 */
export async function recoverQuarantinedResumeOriginal(options: {
  db: Db;
  storage: GetFilesystemOptions;
  quarantineId: string;
  authority: ResumeOriginalRecoveryAuthority;
  authorize: (
    request: ResumeOriginalRecoveryAuthority & { quarantineId: string },
  ) => Promise<boolean>;
  now?: Date;
  filesystem?: FilesystemInterface;
}): Promise<Buffer> {
  const { db, authority } = options;
  for (const field of Object.values(authority)) value(field);
  const request = { ...authority, quarantineId: value(options.quarantineId) };
  if ((await options.authorize(request)) !== true) throw unavailable();
  const row = (
    await db.query(
      'SELECT * FROM resume_import_quarantines WHERE id = ? AND tenant_id = ? AND storage_identity = ?',
      [
        request.quarantineId,
        authority.tenantId,
        resumeStorageIdentity(options.storage),
      ],
    )
  ).rows[0] as Row | undefined;
  if (
    !row ||
    row.purged_at ||
    instant(row.purge_after) <= (options.now ?? new Date())
  )
    throw unavailable();
  const id = randomUUID();
  await db.query(
    `INSERT INTO resume_import_recovery_audits
    (id, slug, context, quarantine_id, tenant_id, actor_id, destination_authority, reason, outcome, created_at, updated_at)
    VALUES (?, ?, 'resume-original-recovery', ?, ?, ?, ?, ?, 'authorized', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
    [
      id,
      id,
      row.id,
      authority.tenantId,
      authority.actorId,
      authority.destinationAuthority,
      authority.reason,
    ],
  );
  try {
    const filesystem =
      options.filesystem ?? (await getFilesystemLazy(options.storage));
    const data = await filesystem.read(value(row.object_key), { raw: true });
    if (
      !Buffer.isBuffer(data) ||
      data.length !== Number(row.byte_length) ||
      createHash('sha256').update(data).digest('hex') !== row.content_hash
    )
      throw unavailable();
    // Never release a response which crossed its deadline during provider I/O.
    if (instant(row.purge_after) <= (options.now ?? new Date()))
      throw unavailable();
    await db.query(
      "UPDATE resume_import_recovery_audits SET outcome = 'verified', updated_at = CURRENT_TIMESTAMP WHERE id = ?",
      [id],
    );
    return data;
  } catch {
    await db.query(
      "UPDATE resume_import_recovery_audits SET outcome = 'failed', updated_at = CURRENT_TIMESTAMP WHERE id = ?",
      [id],
    );
    throw unavailable();
  }
}
