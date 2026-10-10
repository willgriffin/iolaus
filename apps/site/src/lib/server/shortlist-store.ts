import { createHash, randomUUID } from 'node:crypto';
import { detectEngine, type resolveDatabase } from '@happyvertical/smrt-core';
import type { PublicOpportunity } from '$lib/public-opportunity-contract.js';
import type {
  ShortlistEntry,
  ShortlistMutation,
} from '$lib/shortlist-contract.js';
import { shortlistEntrySchema } from '$lib/shortlist-contract.js';
import { withSqliteOperationLock } from './sqlite-operation-lock.js';
import {
  type WorkspaceSubject,
  WorkspaceSubjectError,
} from './workspace-subject.js';

type Database = Awaited<ReturnType<typeof resolveDatabase>>;
type Row = Record<string, unknown>;
const LIMIT = 500;
/** Replaying a successful mutation is supported for seven days. */
const RECEIPT_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

export class ShortlistStoreError extends Error {
  constructor(
    readonly code: 'conflict' | 'limit' | 'receipt_conflict',
    message: string,
    readonly entry?: ShortlistEntry,
  ) {
    super(message);
  }
}

const entryColumns = `
  opportunity_id AS "opportunityId", opportunity_snapshot AS "opportunitySnapshot",
  decision, first_seen_at AS "firstSeenAt", updated_at AS "updatedAt",
  opened_at AS "openedAt", applied_at AS "appliedAt", revision`;

function text(value: unknown): string {
  return typeof value === 'string' ? value : value == null ? '' : String(value);
}
function iso(value: unknown): string {
  const date = value instanceof Date ? value : new Date(text(value));
  return Number.isNaN(date.getTime())
    ? new Date(0).toISOString()
    : date.toISOString();
}
function nullableIso(value: unknown): string | null {
  return value == null || value === '' ? null : iso(value);
}
function snapshot(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}
function entryFrom(row: Row): ShortlistEntry {
  return shortlistEntrySchema.parse({
    opportunity: snapshot(row.opportunitySnapshot),
    decision: text(row.decision),
    firstSeenAt: iso(row.firstSeenAt),
    updatedAt: iso(row.updatedAt),
    openedAt: nullableIso(row.openedAt),
    appliedAt: nullableIso(row.appliedAt),
    revision: Number(row.revision),
    available: row.available === false ? false : undefined,
  });
}
function resultRows(result: { rows?: Row[] } | Row[]): Row[] {
  return Array.isArray(result) ? result : (result.rows ?? []);
}
function tuple(subject: WorkspaceSubject): string[] {
  return [subject.tenantId, subject.userId];
}
export function shortlistOwnerLockKey(subject: WorkspaceSubject): string {
  return createHash('sha256')
    .update(tuple(subject).join('\u0000'))
    .digest('hex');
}
function requestFingerprint(mutation: ShortlistMutation): string {
  return createHash('sha256').update(JSON.stringify(mutation)).digest('hex');
}
function sqlite(database: Database): boolean {
  return Boolean(database.url && detectEngine(database.url) === 'sqlite');
}

/** SQL store for private shortlist state. Every write is serialized by tuple. */
export function createShortlistStore(
  database: Database,
  authorizeWrite?: (
    subject: WorkspaceSubject,
    transaction: Database,
  ) => Promise<void>,
) {
  if (!database.transaction)
    throw new Error('Shortlist persistence requires transactions.');
  const transaction = async <T>(
    subject: WorkspaceSubject,
    work: (db: Database) => Promise<T>,
  ) => {
    const run = async () =>
      await database.transaction!(async (db) => {
        if (!sqlite(database)) {
          await db.query("SET LOCAL lock_timeout = '15s'");
          await db.query('SELECT pg_advisory_xact_lock(hashtext(?))', [
            `shortlist:${shortlistOwnerLockKey(subject)}`,
          ]);
        }
        // Lock the same identity rows deletion disables, in its membership-first
        // order. The no-op updates are native write locks on both supported
        // dialects: deletion either follows this commit or we observe inactive /
        // missing identity and cannot recreate account data after removal.
        for (const [table, where, values] of [
          ['memberships', 'tenant_id = ? AND user_id = ?', tuple(subject)],
          ['users', 'id = ?', [subject.userId]],
          ['tenants', 'id = ?', [subject.tenantId]],
        ] as const) {
          const locked = resultRows(
            await db.query(
              `UPDATE ${table} SET status = status WHERE ${where} AND status = 'active' RETURNING id`,
              [...values],
            ),
          );
          if (!locked.length)
            throw new WorkspaceSubjectError(
              403,
              'Workspace account is no longer active.',
            );
        }
        // Native principal permission resolution must happen after catalog I/O
        // and while lifecycle identity locks protect the imminent write.
        await authorizeWrite?.(subject, db);
        return await work(db);
      });
    return sqlite(database)
      ? await withSqliteOperationLock(
          `shortlist:${shortlistOwnerLockKey(subject)}`,
          run,
        )
      : await run();
  };
  const lookup = async (
    db: Database,
    subject: WorkspaceSubject,
    opportunityId: string,
  ) => {
    const result = await db.query(
      `SELECT ${entryColumns} FROM shortlist_entries
       WHERE tenant_id = ? AND owner_user_id = ? AND opportunity_id = ? LIMIT 1`,
      [...tuple(subject), opportunityId],
    );
    const row = resultRows(result)[0];
    return row ? entryFrom(row) : null;
  };
  const list = async (db: Database, subject: WorkspaceSubject) => {
    const result = await db.query(
      `SELECT ${entryColumns} FROM shortlist_entries
       WHERE tenant_id = ? AND owner_user_id = ?
       ORDER BY updated_at DESC, opportunity_id ASC LIMIT ?`,
      [...tuple(subject), LIMIT],
    );
    return resultRows(result).map(entryFrom);
  };
  return {
    list: async (subject: WorkspaceSubject) => await list(database, subject),
    async mutate(
      subject: WorkspaceSubject,
      mutation: ShortlistMutation,
      currentOpportunity: PublicOpportunity | null,
    ): Promise<ShortlistEntry> {
      return await transaction(subject, async (db) => {
        await db.query(
          `DELETE FROM shortlist_mutation_receipts
           WHERE tenant_id = ? AND owner_user_id = ? AND created_at < ?`,
          [
            ...tuple(subject),
            new Date(Date.now() - RECEIPT_RETENTION_MS).toISOString(),
          ],
        );
        const fingerprint = requestFingerprint(mutation);
        const receipt = resultRows(
          await db.query(
            `SELECT request_fingerprint AS "requestFingerprint", response FROM shortlist_mutation_receipts
           WHERE tenant_id = ? AND owner_user_id = ? AND mutation_id = ? LIMIT 1`,
            [...tuple(subject), mutation.mutationId],
          ),
        )[0];
        if (receipt) {
          if (text(receipt.requestFingerprint) !== fingerprint)
            throw new ShortlistStoreError(
              'receipt_conflict',
              'Mutation ID was already used for a different change.',
            );
          return shortlistEntrySchema.parse(snapshot(receipt.response));
        }
        const existing = await lookup(db, subject, mutation.opportunityId);
        if (!existing && mutation.expectedRevision !== 0)
          throw new ShortlistStoreError(
            'conflict',
            'Shortlist entry changed.',
            undefined,
          );
        if (existing && existing.revision !== mutation.expectedRevision)
          throw new ShortlistStoreError(
            'conflict',
            'Shortlist entry changed.',
            existing,
          );
        if (
          currentOpportunity &&
          currentOpportunity.id !== mutation.opportunityId
        )
          throw new ShortlistStoreError(
            'conflict',
            'Opportunity identity changed.',
          );
        if (!existing && !currentOpportunity)
          throw new ShortlistStoreError(
            'conflict',
            'This opportunity is no longer available.',
          );
        if (!existing) {
          const count = resultRows(
            await db.query(
              `SELECT COUNT(*) AS count FROM shortlist_entries WHERE tenant_id = ? AND owner_user_id = ?`,
              tuple(subject),
            ),
          )[0];
          if (Number(count?.count ?? 0) >= LIMIT)
            throw new ShortlistStoreError('limit', 'Shortlist is full.');
        }
        const now = new Date().toISOString();
        const entry: ShortlistEntry = {
          opportunity: existing?.opportunity ?? currentOpportunity!,
          decision: mutation.decision ?? existing?.decision ?? 'seen',
          firstSeenAt: existing?.firstSeenAt ?? now,
          updatedAt: now,
          openedAt:
            mutation.opened === undefined
              ? (existing?.openedAt ?? null)
              : mutation.opened
                ? now
                : null,
          appliedAt:
            mutation.applied === undefined
              ? (existing?.appliedAt ?? null)
              : mutation.applied
                ? now
                : null,
          revision: (existing?.revision ?? 0) + 1,
        };
        if (existing) {
          const updated = resultRows(
            await db.query(
              `UPDATE shortlist_entries SET decision = ?, opened_at = ?, applied_at = ?, revision = ?, updated_at = CURRENT_TIMESTAMP
             WHERE tenant_id = ? AND owner_user_id = ? AND opportunity_id = ? AND revision = ?
             RETURNING ${entryColumns}`,
              [
                entry.decision,
                entry.openedAt,
                entry.appliedAt,
                entry.revision,
                ...tuple(subject),
                mutation.opportunityId,
                mutation.expectedRevision,
              ],
            ),
          )[0];
          if (!updated)
            throw new ShortlistStoreError(
              'conflict',
              'Shortlist entry changed.',
              (await lookup(db, subject, mutation.opportunityId)) ?? undefined,
            );
          entry.updatedAt = entryFrom(updated).updatedAt;
        } else {
          await db.query(
            `INSERT INTO shortlist_entries (id, slug, context, tenant_id, owner_user_id, opportunity_id, opportunity_snapshot, decision, first_seen_at, opened_at, applied_at, revision, created_at, updated_at)
             VALUES (?, ?, '', ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
            [
              randomUUID(),
              randomUUID(),
              ...tuple(subject),
              mutation.opportunityId,
              JSON.stringify(entry.opportunity),
              entry.decision,
              entry.firstSeenAt,
              entry.openedAt,
              entry.appliedAt,
              entry.revision,
            ],
          );
        }
        await db.query(
          `INSERT INTO shortlist_mutation_receipts (id, slug, context, tenant_id, owner_user_id, mutation_id, request_fingerprint, response, created_at, updated_at)
           VALUES (?, ?, '', ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
          [
            randomUUID(),
            randomUUID(),
            ...tuple(subject),
            mutation.mutationId,
            fingerprint,
            JSON.stringify(entry),
          ],
        );
        return entry;
      });
    },
    async merge(subject: WorkspaceSubject, entries: ShortlistEntry[]) {
      return await transaction(subject, async (db) => {
        const existing = await list(db, subject);
        const ids = new Set(existing.map((entry) => entry.opportunity.id));
        const additions = entries.filter((entry) => {
          if (ids.has(entry.opportunity.id)) return false;
          ids.add(entry.opportunity.id);
          return true;
        });
        if (existing.length + additions.length > LIMIT)
          throw new ShortlistStoreError(
            'limit',
            'Shortlist is full. Import fewer entries first.',
          );
        for (const entry of additions) {
          await db.query(
            `INSERT INTO shortlist_entries (id, slug, context, tenant_id, owner_user_id, opportunity_id, opportunity_snapshot, decision, first_seen_at, opened_at, applied_at, revision, created_at, updated_at)
             VALUES (?, ?, '', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
              randomUUID(),
              randomUUID(),
              ...tuple(subject),
              entry.opportunity.id,
              JSON.stringify(entry.opportunity),
              entry.decision,
              entry.firstSeenAt,
              entry.openedAt,
              entry.appliedAt,
              1,
              entry.firstSeenAt,
              entry.updatedAt,
            ],
          );
        }
        return {
          entries: await list(db, subject),
          acknowledgedIds: entries.map((entry) => entry.opportunity.id),
        };
      });
    },
  };
}
