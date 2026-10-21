import { randomUUID } from 'node:crypto';
import { ObjectRegistry } from '@happyvertical/smrt-core';
import { getDDLStrategy } from '@happyvertical/smrt-core/schema';
import { type DatabaseInterface, getDatabase } from '@happyvertical/sql';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPublicProfileStore } from './public-profile-store.js';
import './smrt.js';

const url = process.env.PUBLIC_PROFILE_POSTGRES_TEST_DATABASE_URL?.trim();
const quote = (value: string) => `"${value.replaceAll('"', '""')}"`;

describe.runIf(url)('public profile native PostgreSQL store', () => {
  let control: DatabaseInterface;
  let database: DatabaseInterface;
  let schema: string;
  beforeAll(async () => {
    schema = `hv_public_profile_${randomUUID().replaceAll('-', '')}`;
    control = await getDatabase({ cache: false, type: 'postgres', url: url! });
    await control.query(`CREATE SCHEMA ${quote(schema)}`);
    const fixtureUrl = new URL(url!);
    fixtureUrl.searchParams.set('options', `-c search_path=${schema},public`);
    database = await getDatabase({
      cache: false,
      type: 'postgres',
      url: fixtureUrl.toString(),
    });
    const ddl = getDDLStrategy('postgres');
    for (const table of [
      'public_profile_identities',
      'public_profile_revisions',
    ]) {
      const definition = Object.values(
        ObjectRegistry.getAllSchemasAsDefinitions(),
      ).find((item) => item.tableName === table);
      if (!definition) throw new Error(`Missing ${table} schema.`);
      for (const statement of [
        ddl.generateCreateTable(definition),
        ...ddl.generateIndexes(definition),
        ...ddl.generateTriggers(definition),
      ])
        await database.query(statement);
    }
  }, 20_000);
  afterAll(async () => {
    await database?.close?.();
    if (control && schema)
      await control.query(`DROP SCHEMA IF EXISTS ${quote(schema)} CASCADE`);
    await control?.close?.();
  });

  it('enforces a global handle and serializes publish against tombstone', async () => {
    const store = createPublicProfileStore(database as never);
    const subject = { tenantId: 'tenant-pg', userId: 'user-pg' };
    const identity = await store.reserve(subject, 'postgres-profile');
    await expect(
      store.reserve(
        { tenantId: 'tenant-other', userId: 'user-other' },
        'postgres-profile',
      ),
    ).rejects.toMatchObject({ code: 'handle_taken' });
    const id = randomUUID();
    const prepared = await store.prepare(subject, {
      id,
      baseRevision: 0,
      snapshot: {
        version: 1,
        name: 'Postgres Example',
        title: '',
        summary: '',
        links: [],
        experience: [],
        education: [],
        other: [],
        skills: [],
      },
      pdfPath: `public-profiles/${identity.id}/${id}/resume.pdf`,
      pdfSha256: 'b'.repeat(64),
      pdfBytes: 10,
      sourceProfileId: 'candidate-pg',
    });
    await Promise.allSettled([
      store.publish(subject, { revisionId: prepared.id, expectedRevision: 0 }),
      store.tombstone(subject),
    ]);
    expect(await store.resolvePublic('postgres-profile')).toBeNull();
  });

  it('enforces owner/tenant isolation, immutable retry ids, stale CAS, rollback, and absent tombstone fences', async () => {
    const store = createPublicProfileStore(database as never);
    const subject = { tenantId: 'tenant-isolation', userId: 'user-isolation' };
    const identity = await store.reserve(subject, 'postgres-isolation');
    const id = randomUUID();
    const prepared = await store.prepare(subject, {
      id,
      baseRevision: 0,
      snapshot: {
        version: 1,
        name: 'Postgres Isolation',
        title: '',
        summary: '',
        links: [],
        experience: [],
        education: [],
        other: [],
        skills: [],
      },
      pdfPath: `public-profiles/${identity.id}/${id}/resume.pdf`,
      pdfSha256: 'c'.repeat(64),
      pdfBytes: 10,
      sourceProfileId: 'candidate-isolation',
    });
    const foreign = { tenantId: subject.tenantId, userId: 'other-user' };
    expect(await store.getPrepared(foreign, prepared.id)).toBeNull();
    await expect(
      store.reserve(
        { tenantId: 'other-tenant', userId: subject.userId },
        'another-handle',
      ),
    ).rejects.toMatchObject({ code: 'handle_taken' });
    await expect(
      store.prepare(subject, {
        ...prepared,
        snapshot: { ...prepared.snapshot, name: 'Changed' },
      }),
    ).rejects.toMatchObject({ code: 'conflict' });
    await expect(
      store.publish(subject, { revisionId: prepared.id, expectedRevision: 3 }),
    ).rejects.toMatchObject({ code: 'conflict' });
    await database.query(
      `CREATE FUNCTION reject_public_profile_status() RETURNS trigger AS $$ BEGIN RAISE EXCEPTION 'status reject'; END; $$ LANGUAGE plpgsql`,
    );
    await database.query(
      `CREATE TRIGGER reject_public_profile_status BEFORE UPDATE OF status ON public_profile_revisions FOR EACH ROW EXECUTE FUNCTION reject_public_profile_status()`,
    );
    await expect(
      store.publish(subject, { revisionId: prepared.id, expectedRevision: 0 }),
    ).rejects.toThrow('status reject');
    expect(await store.getOwner(subject)).toMatchObject({
      currentRevisionId: null,
      revision: 0,
    });
    const deleted = { tenantId: 'deleted-tenant', userId: 'deleted-user' };
    await store.tombstone(deleted);
    await expect(
      store.reserve(deleted, 'deleted-profile'),
    ).rejects.toMatchObject({ code: 'deleted' });
  });

  it('exports all paginated owner revisions and no foreign rows', async () => {
    const store = createPublicProfileStore(database as never);
    const subject = { tenantId: 'tenant-export', userId: 'user-export' };
    const identity = await store.reserve(subject, 'postgres-export');
    const snapshot = JSON.stringify({
      version: 1,
      name: 'Export',
      title: '',
      summary: '',
      links: [],
      experience: [],
      education: [],
      other: [],
      skills: [],
    });
    const ids = Array.from({ length: 101 }, () => randomUUID());
    for (const id of ids) {
      await database.query(
        `INSERT INTO public_profile_revisions
         (id, slug, context, publication_id, revision_id, base_revision, snapshot, pdf_path, pdf_sha256, pdf_bytes, source_profile_id, status)
         VALUES (?, ?, '', ?, ?, 0, ?, ?, ?, 1, 'candidate-export', 'prepared')`,
        [
          randomUUID(),
          id,
          identity.id,
          id,
          snapshot,
          `public-profiles/${identity.id}/${id}/resume.pdf`,
          'f'.repeat(64),
        ],
      );
    }
    const exported = await store.exportOwner(subject);
    expect(exported.identity?.id).toBe(identity.id);
    expect(exported.revisions).toHaveLength(101);
    expect(new Set(exported.revisions.map((revision) => revision.id))).toEqual(
      new Set(ids),
    );
    await expect(
      store.exportOwner({
        tenantId: subject.tenantId,
        userId: 'foreign-export',
      }),
    ).resolves.toEqual({ identity: null, revisions: [] });
  });
});
