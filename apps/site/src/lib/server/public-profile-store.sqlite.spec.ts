import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ObjectRegistry } from '@happyvertical/smrt-core';
import { getDDLStrategy } from '@happyvertical/smrt-core/schema';
import { type DatabaseInterface, getDatabase } from '@happyvertical/sql';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { PublicProfileSnapshotV1 } from '$lib/public-profile-contract.js';
import { createPublicProfileStore } from './public-profile-store.js';
import './smrt.js';

const owner = { tenantId: 'tenant-a', userId: 'user-a' };
const snapshot: PublicProfileSnapshotV1 = {
  version: 1,
  name: 'Avery Example',
  title: '',
  summary: '',
  links: [],
  experience: [],
  education: [],
  other: [],
  skills: [],
};

describe('public profile native SQLite store', () => {
  let directory: string;
  let database: DatabaseInterface;
  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'iolaus-public-profile-'));
    database = await getDatabase({
      cache: false,
      type: 'sqlite',
      url: join(directory, 'profiles.sqlite'),
    });
    const ddl = getDDLStrategy('sqlite');
    for (const tableName of [
      'public_profile_identities',
      'public_profile_revisions',
    ]) {
      const definition = Object.values(
        ObjectRegistry.getAllSchemasAsDefinitions(),
      ).find((item) => item.tableName === tableName);
      if (!definition) throw new Error(`Missing ${tableName} schema.`);
      for (const statement of [
        ddl.generateCreateTable(definition),
        ...ddl.generateIndexes(definition),
        ...ddl.generateTriggers(definition),
      ])
        await database.query(statement);
    }
  });
  afterEach(async () => {
    await database?.close?.();
    await rm(directory, { force: true, recursive: true });
  });

  function input(
    identityId: string,
    baseRevision = 0,
    id: string = randomUUID(),
  ) {
    return {
      id,
      baseRevision,
      snapshot,
      pdfPath: `public-profiles/${identityId}/${id}/resume.pdf`,
      pdfSha256: 'a'.repeat(64),
      pdfBytes: 10,
      sourceProfileId: 'candidate-a',
    };
  }

  it('uses native unique handles, immutable prepared revisions, CAS, and private artifact metadata', async () => {
    const store = createPublicProfileStore(database as never);
    const identity = await store.reserve(owner, 'Avery-Example');
    expect(identity.handle).toBe('avery-example');
    await expect(
      store.reserve(
        { tenantId: 'tenant-b', userId: 'user-b' },
        'avery-example',
      ),
    ).rejects.toMatchObject({ code: 'handle_taken' });
    const prepared = await store.prepare(owner, input(identity.id));
    await expect(
      store.prepare(owner, {
        ...input(identity.id, 0, prepared.id),
        pdfPath: `public-profiles/${identity.id}/${prepared.id}/resume.pdf`,
      }),
    ).resolves.toEqual(prepared);
    const published = await store.publish(owner, {
      revisionId: prepared.id,
      expectedRevision: 0,
    });
    expect(published).toMatchObject({
      revision: 1,
      candidateProfileId: 'candidate-a',
    });
    await expect(
      store.publish(owner, { revisionId: prepared.id, expectedRevision: 0 }),
    ).resolves.toEqual(published);
    const publicRecord = await store.resolvePublic('AVERY-example');
    expect(publicRecord).toMatchObject({
      identity: { handle: 'avery-example', currentRevisionId: prepared.id },
      revision: { id: prepared.id, pdfPath: prepared.pdfPath, snapshot },
    });
    await expect(store.unpublish(owner, 0)).rejects.toMatchObject({
      code: 'conflict',
    });
    await store.unpublish(owner, 1);
    expect(await store.resolvePublic('avery-example')).toBeNull();
  });

  it('tombstones inside the publication lock so a racing publish cannot resurrect a profile', async () => {
    const store = createPublicProfileStore(database as never);
    const identity = await store.reserve(owner, 'avery-race');
    const prepared = await store.prepare(owner, input(identity.id));
    const [publish, removed] = await Promise.allSettled([
      store.publish(owner, { revisionId: prepared.id, expectedRevision: 0 }),
      store.tombstone(owner),
    ]);
    expect(removed.status).toBe('fulfilled');
    expect(await store.resolvePublic('avery-race')).toBeNull();
    if (publish.status === 'rejected')
      expect(publish.reason).toMatchObject({ code: 'deleted' });
    const manifest = await store.tombstone(owner);
    expect(manifest?.artifactPaths).toEqual([prepared.pdfPath]);
    expect(await store.purgeTombstonedRevisions(owner)).toBe(1);
  });

  it('denies foreign tenant/owner reads, stale CAS, changed retry IDs, and cross-tenant user rebinding', async () => {
    const store = createPublicProfileStore(database as never);
    const identity = await store.reserve(owner, 'avery-isolation');
    const prepared = await store.prepare(owner, input(identity.id));
    const foreignOwner = { tenantId: owner.tenantId, userId: 'user-b' };
    const foreignTenant = { tenantId: 'tenant-b', userId: owner.userId };
    expect(await store.getOwner(foreignOwner)).toBeNull();
    expect(await store.getPrepared(foreignOwner, prepared.id)).toBeNull();
    expect(await store.getPrepared(foreignTenant, prepared.id)).toBeNull();
    await expect(
      store.reserve(foreignTenant, 'different-handle'),
    ).rejects.toMatchObject({ code: 'handle_taken' });
    await expect(
      store.prepare(owner, {
        ...input(identity.id, 0, prepared.id),
        snapshot: { ...snapshot, name: 'Changed' },
        pdfPath: prepared.pdfPath,
      }),
    ).rejects.toMatchObject({ code: 'conflict' });
    await expect(
      store.publish(owner, { revisionId: prepared.id, expectedRevision: 1 }),
    ).rejects.toMatchObject({ code: 'conflict' });
    await store.publish(owner, {
      revisionId: prepared.id,
      expectedRevision: 0,
    });
    await expect(store.unpublish(owner, 0)).rejects.toMatchObject({
      code: 'conflict',
    });
    await expect(
      store.publish(foreignOwner, {
        revisionId: prepared.id,
        expectedRevision: 1,
      }),
    ).rejects.toMatchObject({ code: 'not_found' });
  });

  it('rolls back the pointer when the immutable revision status update fails', async () => {
    const store = createPublicProfileStore(database as never);
    const identity = await store.reserve(owner, 'avery-rollback');
    const prepared = await store.prepare(owner, input(identity.id));
    await database.query(
      `CREATE TRIGGER reject_public_profile_publish BEFORE UPDATE OF status ON public_profile_revisions BEGIN SELECT RAISE(ABORT, 'revision receipt failed'); END`,
    );
    await expect(
      store.publish(owner, { revisionId: prepared.id, expectedRevision: 0 }),
    ).rejects.toThrow('revision receipt failed');
    expect(await store.getOwner(owner)).toMatchObject({
      revision: 0,
      currentRevisionId: null,
    });
    expect(await store.resolvePublic('avery-rollback')).toBeNull();
  });

  it('creates an absent-account tombstone fence that blocks a later reserve', async () => {
    const store = createPublicProfileStore(database as never);
    const deleted = { tenantId: 'tenant-deleted', userId: 'user-deleted' };
    const tombstone = await store.tombstone(deleted);
    expect(tombstone?.artifactPaths).toEqual([]);
    await expect(store.reserve(deleted, 'never-visible')).rejects.toMatchObject(
      { code: 'deleted' },
    );
  });

  it('exports every owner revision across pages and excludes foreign rows', async () => {
    const store = createPublicProfileStore(database as never);
    const identity = await store.reserve(owner, 'avery-export');
    const ids = Array.from({ length: 101 }, () => randomUUID());
    for (const id of ids) {
      await database.query(
        `INSERT INTO public_profile_revisions
         (id, slug, context, publication_id, revision_id, base_revision, snapshot, pdf_path, pdf_sha256, pdf_bytes, source_profile_id, status)
         VALUES (?, ?, '', ?, ?, 0, ?, ?, ?, 1, 'candidate-a', 'prepared')`,
        [
          randomUUID(),
          id,
          identity.id,
          id,
          JSON.stringify(snapshot),
          `public-profiles/${identity.id}/${id}/resume.pdf`,
          'd'.repeat(64),
        ],
      );
    }
    const exported = await store.exportOwner(owner);
    expect(exported.identity?.id).toBe(identity.id);
    expect(exported.revisions).toHaveLength(101);
    expect(new Set(exported.revisions.map((entry) => entry.id))).toEqual(
      new Set(ids),
    );
    await database.query(
      `INSERT INTO public_profile_revisions
       (id, slug, context, publication_id, revision_id, base_revision, snapshot, pdf_path, pdf_sha256, pdf_bytes, source_profile_id, status)
       VALUES (?, 'foreign', '', ?, ?, 0, ?, 'public-profiles/foreign/revision/resume.pdf', ?, 1, 'foreign', 'prepared')`,
      [
        randomUUID(),
        randomUUID(),
        randomUUID(),
        JSON.stringify(snapshot),
        'e'.repeat(64),
      ],
    );
    expect((await store.exportOwner(owner)).revisions).toHaveLength(101);
    await expect(
      store.exportOwner({ tenantId: owner.tenantId, userId: 'foreign-user' }),
    ).resolves.toEqual({ identity: null, revisions: [] });
  });
});
