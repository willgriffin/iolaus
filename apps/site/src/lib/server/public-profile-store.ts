import { createHash, randomUUID } from 'node:crypto';
import { detectEngine, type resolveDatabase } from '@happyvertical/smrt-core';
import {
  normalizePublicProfileHandle,
  type PublicProfileSnapshotV1,
  publicProfileSnapshotSchema,
} from '$lib/public-profile-contract.js';
import { withSqliteOperationLock } from './sqlite-operation-lock.js';
import type { WorkspaceSubject } from './workspace-subject.js';

type Database = Awaited<ReturnType<typeof resolveDatabase>>;
type Row = Record<string, unknown>;
export type PublicProfileSubject = Pick<
  WorkspaceSubject,
  'tenantId' | 'userId'
>;
const MAX_PREPARED_PER_48H = 20;
const PREPARED_WINDOW_MS = 48 * 60 * 60 * 1_000;
const MAX_PDF_BYTES = 10 * 1024 * 1024;
const MAX_SNAPSHOT_BYTES = 1_000_000;
const EXPORT_PAGE_SIZE = 100;

export class PublicProfileStoreError extends Error {
  constructor(
    readonly code:
      | 'conflict'
      | 'deleted'
      | 'handle_taken'
      | 'not_found'
      | 'limit'
      | 'validation',
    message: string,
  ) {
    super(message);
  }
}

export interface PublicProfileIdentity {
  id: string;
  tenantId: string;
  ownerUserId: string;
  handle: string;
  candidateProfileId: string;
  currentRevisionId: string | null;
  revision: number;
  publishedAt: string | null;
  deletedAt: string | null;
}

export interface PreparedPublicProfileRevision {
  id: string;
  publicationId: string;
  baseRevision: number;
  snapshot: PublicProfileSnapshotV1;
  pdfPath: string;
  pdfSha256: string;
  pdfBytes: number;
  sourceProfileId: string;
  status: 'prepared' | 'published';
  publishedRevision: number | null;
  createdAt: string;
}

export interface ResolvedPublicProfile {
  identity: Pick<
    PublicProfileIdentity,
    'id' | 'handle' | 'revision' | 'currentRevisionId' | 'publishedAt'
  >;
  revision: PreparedPublicProfileRevision;
}

/** Artifact cleanup plan captured atomically with the irreversible tombstone. */
export interface TombstonedPublicProfile {
  identity: PublicProfileIdentity;
  artifactPaths: string[];
}

export interface PreparePublicProfileInput {
  id: string;
  baseRevision: number;
  snapshot: PublicProfileSnapshotV1;
  pdfPath: string;
  pdfSha256: string;
  pdfBytes: number;
  sourceProfileId: string;
}

function rows(result: { rows?: Row[] } | Row[]): Row[] {
  return Array.isArray(result) ? result : (result.rows ?? []);
}
function string(value: unknown): string {
  return typeof value === 'string' ? value : value == null ? '' : String(value);
}
function iso(value: unknown): string {
  const date = value instanceof Date ? value : new Date(string(value));
  return Number.isNaN(date.getTime())
    ? new Date(0).toISOString()
    : date.toISOString();
}
function nullableIso(value: unknown): string | null {
  return value == null || value === '' ? null : iso(value);
}
function json(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}
function identity(row: Row): PublicProfileIdentity {
  return {
    id: string(row.id),
    tenantId: string(row.tenantId),
    ownerUserId: string(row.ownerUserId),
    handle: string(row.handle),
    candidateProfileId: string(row.candidateProfileId),
    currentRevisionId:
      row.currentRevisionId == null ? null : string(row.currentRevisionId),
    revision: Number(row.revision),
    publishedAt: nullableIso(row.publishedAt),
    deletedAt: nullableIso(row.deletedAt),
  };
}
function revision(row: Row): PreparedPublicProfileRevision {
  const status = string(row.status);
  return {
    // `revision_id` is the externally supplied immutable revision identity.
    // The SMRT row id remains an internal database implementation detail.
    id: string(row.revisionId),
    publicationId: string(row.publicationId),
    baseRevision: Number(row.baseRevision),
    snapshot: publicProfileSnapshotSchema.parse(json(row.snapshot)),
    pdfPath: string(row.pdfPath),
    pdfSha256: string(row.pdfSha256),
    pdfBytes: Number(row.pdfBytes),
    sourceProfileId: string(row.sourceProfileId),
    status: status === 'published' ? 'published' : 'prepared',
    publishedRevision:
      row.publishedRevision == null ? null : Number(row.publishedRevision),
    createdAt: iso(row.createdAt),
  };
}
const identityColumns = `id, tenant_id AS "tenantId", owner_user_id AS "ownerUserId",
 handle, candidate_profile_id AS "candidateProfileId",
 current_revision_id AS "currentRevisionId", revision, published_at AS "publishedAt", deleted_at AS "deletedAt"`;
const revisionColumns = `id, publication_id AS "publicationId", revision_id AS "revisionId",
 base_revision AS "baseRevision", snapshot, pdf_path AS "pdfPath", pdf_sha256 AS "pdfSha256",
 pdf_bytes AS "pdfBytes", source_profile_id AS "sourceProfileId", status,
 published_revision AS "publishedRevision", created_at AS "createdAt"`;
const resolvedRevisionColumns = `r.id, r.publication_id AS "publicationId", r.revision_id AS "revisionId",
 r.base_revision AS "baseRevision", r.snapshot, r.pdf_path AS "pdfPath", r.pdf_sha256 AS "pdfSha256",
 r.pdf_bytes AS "pdfBytes", r.source_profile_id AS "sourceProfileId", r.status,
 r.published_revision AS "publishedRevision", r.created_at AS "createdAt"`;

function sqlite(database: Database): boolean {
  return Boolean(database.url && detectEngine(database.url) === 'sqlite');
}
function lockKey(userId: string): string {
  return `public-profile:${createHash('sha256').update(userId).digest('hex')}`;
}
function subject(subject: PublicProfileSubject): [string, string] {
  if (!subject.tenantId?.trim() || !subject.userId?.trim())
    throw new PublicProfileStoreError(
      'validation',
      'A verified owner is required.',
    );
  return [subject.tenantId, subject.userId];
}
function assertPreparedInput(input: PreparePublicProfileInput): void {
  if (!/^[A-Za-z0-9_-]{8,128}$/u.test(input.id))
    throw new PublicProfileStoreError(
      'validation',
      'Prepared revision ID is invalid.',
    );
  if (!Number.isSafeInteger(input.baseRevision) || input.baseRevision < 0)
    throw new PublicProfileStoreError(
      'validation',
      'Base revision is invalid.',
    );
  if (!/^[a-f0-9]{64}$/iu.test(input.pdfSha256))
    throw new PublicProfileStoreError('validation', 'PDF checksum is invalid.');
  if (
    !Number.isSafeInteger(input.pdfBytes) ||
    input.pdfBytes < 1 ||
    input.pdfBytes > MAX_PDF_BYTES
  )
    throw new PublicProfileStoreError('validation', 'PDF size is invalid.');
  if (!input.sourceProfileId?.trim() || input.sourceProfileId.length > 160)
    throw new PublicProfileStoreError(
      'validation',
      'Source profile is invalid.',
    );
  const snapshot = publicProfileSnapshotSchema.parse(input.snapshot);
  if (Buffer.byteLength(JSON.stringify(snapshot), 'utf8') > MAX_SNAPSHOT_BYTES)
    throw new PublicProfileStoreError(
      'validation',
      'Public snapshot is too large.',
    );
}

/**
 * Raw SQL persistence boundary for immutable public-profile revisions. The
 * service supplies only a verified workspace subject; this store never trusts
 * candidate/profile ids supplied by a browser as an ownership proof.
 */
export function createPublicProfileStore(database: Database) {
  if (!database.transaction)
    throw new Error('Public-profile persistence requires transactions.');
  const locked = async <T>(
    userId: string,
    work: (db: Database) => Promise<T>,
  ): Promise<T> => {
    const run = async () =>
      await database.transaction!(async (db) => {
        if (!sqlite(database)) {
          await db.query("SET LOCAL lock_timeout = '15s'");
          await db.query('SELECT pg_advisory_xact_lock(hashtext(?))', [
            lockKey(userId),
          ]);
        }
        return await work(db);
      });
    return sqlite(database)
      ? await withSqliteOperationLock(lockKey(userId), run)
      : await run();
  };
  const owner = async (db: Database, value: PublicProfileSubject) => {
    const [tenantId, userId] = subject(value);
    const row = rows(
      await db.query(
        `SELECT ${identityColumns} FROM public_profile_identities
         WHERE tenant_id = ? AND owner_user_id = ? LIMIT 1`,
        [tenantId, userId],
      ),
    )[0];
    return row ? identity(row) : null;
  };
  const ownedRevision = async (
    db: Database,
    profile: PublicProfileIdentity,
    id: string,
  ) => {
    const row = rows(
      await db.query(
        `SELECT ${revisionColumns} FROM public_profile_revisions
         WHERE publication_id = ? AND revision_id = ? LIMIT 1`,
        [profile.id, id],
      ),
    )[0];
    return row ? revision(row) : null;
  };
  const assertActive = (
    profile: PublicProfileIdentity | null,
  ): PublicProfileIdentity => {
    if (!profile)
      throw new PublicProfileStoreError(
        'not_found',
        'Public profile is not reserved.',
      );
    if (profile.deletedAt)
      throw new PublicProfileStoreError(
        'deleted',
        'Public profile was deleted.',
      );
    return profile;
  };

  return {
    getOwner: async (value: PublicProfileSubject) =>
      await owner(database, value),
    async reserve(
      value: PublicProfileSubject,
      rawHandle: string,
    ): Promise<PublicProfileIdentity> {
      const [tenantId, userId] = subject(value);
      const handle = normalizePublicProfileHandle(rawHandle);
      return await locked(userId, async (db) => {
        const existing = await owner(db, value);
        if (existing) {
          if (existing.deletedAt)
            throw new PublicProfileStoreError(
              'deleted',
              'Public profile was deleted.',
            );
          if (existing.handle !== handle)
            throw new PublicProfileStoreError(
              'conflict',
              'Public profile handle is immutable.',
            );
          return existing;
        }
        try {
          const created = rows(
            await db.query(
              `INSERT INTO public_profile_identities
                 (id, slug, context, tenant_id, owner_user_id, handle, candidate_profile_id, revision)
               VALUES (?, ?, '', ?, ?, ?, '', 0)
               RETURNING ${identityColumns}`,
              [randomUUID(), handle, tenantId, userId, handle],
            ),
          )[0];
          if (!created)
            throw new Error('Public profile reservation did not return a row.');
          return identity(created);
        } catch (error) {
          // Native unique constraints are the concurrent handle-claim fence.
          if (String(error).toLowerCase().includes('unique'))
            throw new PublicProfileStoreError(
              'handle_taken',
              'Public profile handle is unavailable.',
            );
          throw error;
        }
      });
    },
    async prepare(
      value: PublicProfileSubject,
      input: PreparePublicProfileInput,
    ): Promise<PreparedPublicProfileRevision> {
      assertPreparedInput(input);
      const [, userId] = subject(value);
      return await locked(userId, async (db) => {
        const profile = assertActive(await owner(db, value));
        if (profile.revision !== input.baseRevision)
          throw new PublicProfileStoreError(
            'conflict',
            'Public profile changed. Refresh the preview.',
          );
        const expectedPath = `public-profiles/${profile.id}/${input.id}/resume.pdf`;
        if (input.pdfPath !== expectedPath)
          throw new PublicProfileStoreError(
            'validation',
            'PDF path is outside the prepared revision scope.',
          );
        const prior = await ownedRevision(db, profile, input.id);
        if (prior) {
          const same =
            prior.baseRevision === input.baseRevision &&
            prior.pdfPath === input.pdfPath &&
            prior.pdfSha256 === input.pdfSha256.toLowerCase() &&
            prior.pdfBytes === input.pdfBytes &&
            prior.sourceProfileId === input.sourceProfileId &&
            JSON.stringify(prior.snapshot) ===
              JSON.stringify(publicProfileSnapshotSchema.parse(input.snapshot));
          if (!same)
            throw new PublicProfileStoreError(
              'conflict',
              'Prepared revision ID was already used.',
            );
          return prior;
        }
        const since = new Date(Date.now() - PREPARED_WINDOW_MS).toISOString();
        const count = rows(
          await db.query(
            `SELECT COUNT(*) AS count FROM public_profile_revisions
           WHERE publication_id = ? AND created_at >= ?`,
            [profile.id, since],
          ),
        )[0];
        if (Number(count?.count ?? 0) >= MAX_PREPARED_PER_48H)
          throw new PublicProfileStoreError(
            'limit',
            'Too many prepared public profile revisions.',
          );
        const row = rows(
          await db.query(
            `INSERT INTO public_profile_revisions
             (id, slug, context, publication_id, revision_id, base_revision, snapshot, pdf_path, pdf_sha256, pdf_bytes, source_profile_id, status)
           VALUES (?, ?, '', ?, ?, ?, ?, ?, ?, ?, ?, 'prepared') RETURNING ${revisionColumns}`,
            [
              randomUUID(),
              input.id,
              profile.id,
              input.id,
              input.baseRevision,
              JSON.stringify(publicProfileSnapshotSchema.parse(input.snapshot)),
              input.pdfPath,
              input.pdfSha256.toLowerCase(),
              input.pdfBytes,
              input.sourceProfileId,
            ],
          ),
        )[0];
        if (!row)
          throw new Error(
            'Prepared public profile revision did not return a row.',
          );
        return revision(row);
      });
    },
    async getPrepared(value: PublicProfileSubject, id: string) {
      const profile = await owner(database, value);
      if (!profile || profile.deletedAt) return null;
      const found = await ownedRevision(database, profile, id);
      return found;
    },
    async listRevisions(
      value: PublicProfileSubject,
    ): Promise<PreparedPublicProfileRevision[]> {
      const profile = assertActive(await owner(database, value));
      return rows(
        await database.query(
          `SELECT ${revisionColumns} FROM public_profile_revisions
         WHERE publication_id = ? ORDER BY created_at DESC LIMIT 100`,
          [profile.id],
        ),
      ).map(revision);
    },
    /** Owner-only export shape; callers must not substitute the public resolver. */
    async exportOwner(value: PublicProfileSubject): Promise<{
      identity: PublicProfileIdentity | null;
      revisions: PreparedPublicProfileRevision[];
    }> {
      return await database.transaction!(async (db) => {
        if (!sqlite(database))
          await db.query(
            'SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY',
          );
        const profile = await owner(db, value);
        if (!profile) return { identity: null, revisions: [] };
        const revisions: PreparedPublicProfileRevision[] = [];
        for (let offset = 0; ; offset += EXPORT_PAGE_SIZE) {
          const page = rows(
            await db.query(
              `SELECT ${revisionColumns} FROM public_profile_revisions
               WHERE publication_id = ?
               ORDER BY created_at ASC, revision_id ASC LIMIT ? OFFSET ?`,
              [profile.id, EXPORT_PAGE_SIZE, offset],
            ),
          ).map(revision);
          revisions.push(...page);
          if (page.length < EXPORT_PAGE_SIZE) break;
        }
        return { identity: profile, revisions };
      });
    },
    async listPublicProfileArtifactPaths(
      value: PublicProfileSubject,
    ): Promise<string[]> {
      const profile = await owner(database, value);
      if (!profile) return [];
      return rows(
        await database.query(
          `SELECT pdf_path AS "pdfPath" FROM public_profile_revisions WHERE publication_id = ? ORDER BY created_at ASC`,
          [profile.id],
        ),
      ).map((row) => string(row.pdfPath));
    },
    async publish(
      value: PublicProfileSubject,
      input: { revisionId: string; expectedRevision: number },
    ): Promise<PublicProfileIdentity> {
      if (
        !Number.isSafeInteger(input.expectedRevision) ||
        input.expectedRevision < 0
      )
        throw new PublicProfileStoreError(
          'validation',
          'Expected revision is invalid.',
        );
      const [, userId] = subject(value);
      return await locked(userId, async (db) => {
        const profile = assertActive(await owner(db, value));
        const prepared = await ownedRevision(db, profile, input.revisionId);
        if (!prepared)
          throw new PublicProfileStoreError(
            'not_found',
            'Prepared public profile revision was not found.',
          );
        // A dropped response can retry the same prepared revision harmlessly.
        if (profile.currentRevisionId === prepared.id) return profile;
        if (
          profile.revision !== input.expectedRevision ||
          prepared.baseRevision !== input.expectedRevision
        )
          throw new PublicProfileStoreError(
            'conflict',
            'Public profile changed. Refresh before publishing.',
          );
        const next = profile.revision + 1;
        const updated = rows(
          await db.query(
            `UPDATE public_profile_identities
           SET current_revision_id = ?, candidate_profile_id = ?, revision = ?, published_at = CURRENT_TIMESTAMP
           WHERE id = ? AND tenant_id = ? AND owner_user_id = ? AND revision = ? AND deleted_at IS NULL
           RETURNING ${identityColumns}`,
            [
              prepared.id,
              prepared.sourceProfileId,
              next,
              profile.id,
              profile.tenantId,
              profile.ownerUserId,
              profile.revision,
            ],
          ),
        )[0];
        if (!updated)
          throw new PublicProfileStoreError(
            'conflict',
            'Public profile changed.',
          );
        await db.query(
          `UPDATE public_profile_revisions SET status = 'published', published_revision = ?
           WHERE publication_id = ? AND revision_id = ?`,
          [next, profile.id, prepared.id],
        );
        return identity(updated);
      });
    },
    async unpublish(
      value: PublicProfileSubject,
      expectedRevision: number,
    ): Promise<PublicProfileIdentity> {
      if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0)
        throw new PublicProfileStoreError(
          'validation',
          'Expected revision is invalid.',
        );
      const [, userId] = subject(value);
      return await locked(userId, async (db) => {
        const profile = assertActive(await owner(db, value));
        if (
          !profile.currentRevisionId &&
          profile.revision === expectedRevision + 1
        )
          return profile;
        if (profile.revision !== expectedRevision)
          throw new PublicProfileStoreError(
            'conflict',
            'Public profile changed.',
          );
        const updated = rows(
          await db.query(
            `UPDATE public_profile_identities SET current_revision_id = NULL, revision = ?
           WHERE id = ? AND tenant_id = ? AND owner_user_id = ? AND revision = ? AND deleted_at IS NULL
           RETURNING ${identityColumns}`,
            [
              profile.revision + 1,
              profile.id,
              profile.tenantId,
              profile.ownerUserId,
              profile.revision,
            ],
          ),
        )[0];
        if (!updated)
          throw new PublicProfileStoreError(
            'conflict',
            'Public profile changed.',
          );
        return identity(updated);
      });
    },
    async tombstone(
      value: PublicProfileSubject | string,
    ): Promise<TombstonedPublicProfile | null> {
      const userId = typeof value === 'string' ? value : subject(value)[1];
      return await locked(userId, async (db) => {
        const query =
          typeof value === 'string'
            ? `SELECT ${identityColumns} FROM public_profile_identities WHERE owner_user_id = ? LIMIT 1`
            : `SELECT ${identityColumns} FROM public_profile_identities WHERE tenant_id = ? AND owner_user_id = ? LIMIT 1`;
        const params = typeof value === 'string' ? [userId] : subject(value);
        const found = rows(await db.query(query, params))[0];
        if (!found) {
          if (typeof value === 'string') return null;
          // A deletion which races first publication leaves a permanent fence:
          // a stale authenticated request can never reserve after account
          // deletion begins. This synthetic handle is never externally known.
          const tombstoneId = randomUUID();
          const tombstoneHandle = `deleted-${tombstoneId}`;
          const created = rows(
            await db.query(
              `INSERT INTO public_profile_identities
               (id, slug, context, tenant_id, owner_user_id, handle, candidate_profile_id, revision, deleted_at)
             VALUES (?, ?, '', ?, ?, ?, '', 1, CURRENT_TIMESTAMP)
             RETURNING ${identityColumns}`,
              [
                tombstoneId,
                tombstoneHandle,
                value.tenantId,
                value.userId,
                tombstoneHandle,
              ],
            ),
          )[0];
          if (!created)
            throw new Error(
              'Public profile deletion fence did not return a row.',
            );
          return { artifactPaths: [], identity: identity(created) };
        }
        const profile = identity(found);
        const artifactPaths = rows(
          await db.query(
            `SELECT pdf_path AS "pdfPath" FROM public_profile_revisions WHERE publication_id = ? ORDER BY created_at ASC`,
            [profile.id],
          ),
        ).map((row) => string(row.pdfPath));
        if (profile.deletedAt) return { artifactPaths, identity: profile };
        const updated = rows(
          await db.query(
            `UPDATE public_profile_identities
           SET deleted_at = CURRENT_TIMESTAMP, current_revision_id = NULL, revision = ?
           WHERE id = ? AND deleted_at IS NULL RETURNING ${identityColumns}`,
            [profile.revision + 1, profile.id],
          ),
        )[0];
        return {
          artifactPaths,
          identity: updated ? identity(updated) : profile,
        };
      });
    },
    async purgeTombstonedRevisions(
      value: PublicProfileSubject,
    ): Promise<number> {
      const [, userId] = subject(value);
      return await locked(userId, async (db) => {
        const profile = await owner(db, value);
        if (!profile || !profile.deletedAt) return 0;
        const response = await db.query(
          `DELETE FROM public_profile_revisions WHERE publication_id = ?`,
          [profile.id],
        );
        return Number((response as { rowCount?: unknown }).rowCount ?? 0);
      });
    },
    async resolvePublic(
      rawHandle: string,
    ): Promise<ResolvedPublicProfile | null> {
      let handle: string;
      try {
        handle = normalizePublicProfileHandle(rawHandle);
      } catch {
        return null;
      }
      const row = rows(
        await database.query(
          `SELECT i.id AS "identityId", i.handle AS "identityHandle", i.revision AS "identityRevision", i.published_at AS "publishedAt",
                i.current_revision_id AS "identityCurrentRevisionId", ${resolvedRevisionColumns}
         FROM public_profile_identities i
         JOIN public_profile_revisions r ON CAST(r.publication_id AS TEXT) = CAST(i.id AS TEXT)
           AND CAST(r.revision_id AS TEXT) = CAST(i.current_revision_id AS TEXT)
         WHERE i.handle = ? AND i.deleted_at IS NULL AND i.current_revision_id IS NOT NULL
         LIMIT 1`,
          [handle],
        ),
      )[0];
      if (!row) return null;
      return {
        identity: {
          id: string(row.identityId),
          handle: string(row.identityHandle),
          revision: Number(row.identityRevision),
          currentRevisionId: string(row.identityCurrentRevisionId),
          publishedAt: nullableIso(row.publishedAt),
        },
        revision: revision(row),
      };
    },
  };
}

/** Lifecycle-friendly deletion facade. It uses the same lock as publication. */
export async function tombstonePublicProfile(
  database: Database,
  subject: PublicProfileSubject | string,
): Promise<TombstonedPublicProfile | null> {
  return await createPublicProfileStore(database).tombstone(subject);
}

/**
 * Phase-three account cleanup. It deliberately preserves the identity row and
 * its globally reserved handle, while making repeated cleanup safe.
 */
export async function purgeTombstonedPublicProfileRevisions(
  database: Database,
  subject: PublicProfileSubject,
): Promise<number> {
  return await createPublicProfileStore(database).purgeTombstonedRevisions(
    subject,
  );
}
