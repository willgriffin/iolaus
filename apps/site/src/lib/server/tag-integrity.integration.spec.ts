import { randomUUID } from 'node:crypto';
import { copyFile, mkdtemp, rm, stat, truncate } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveDatabase } from '@happyvertical/smrt-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  runPgDump,
  runPgRestore,
  verifyDatabaseDump,
} from '../../../scripts/db-snapshot.js';
import {
  applyTagIntegrityRepair,
  getTagIntegrityGuardStatus,
  inspectTagIntegrity,
} from './tag-integrity.js';

const databaseUrl = process.env.TAG_INTEGRITY_TEST_DATABASE_URL?.trim();
const enabled = Boolean(databaseUrl);
const TAG_ID = '11111111-1111-4111-8111-111111111111';
const ACHIEVEMENT_ID = '22222222-2222-4222-8222-222222222222';
const MISSING_ACHIEVEMENT_ID = '33333333-3333-4333-8333-333333333333';

describe.runIf(enabled)('tag integrity repair integration', () => {
  let db: Awaited<ReturnType<typeof resolveDatabase>>;

  beforeAll(async () => {
    if (!databaseUrl)
      throw new Error('TAG_INTEGRITY_TEST_DATABASE_URL is required.');
    const parsed = new URL(databaseUrl);
    const databaseName = parsed.pathname.replace(/^\/+/, '');
    if (
      !['localhost', '127.0.0.1', '::1'].includes(parsed.hostname) ||
      !databaseName.includes('tag_integrity_test')
    ) {
      throw new Error(
        'Integration test requires a local database named with tag_integrity_test.',
      );
    }
    db = await resolveDatabase(
      { type: 'postgres', url: databaseUrl },
      { dbid: `tag-integrity-test-${randomUUID()}` },
    );
    await db.query('DROP TABLE IF EXISTS data_repair_audit CASCADE');
    await db.query('DROP TABLE IF EXISTS data_repair_runs CASCADE');
    await db.query('DROP TABLE IF EXISTS achievement_tags CASCADE');
    await db.query('DROP TABLE IF EXISTS achievements CASCADE');
    await db.query('DROP TABLE IF EXISTS tags CASCADE');
    await db.query('DROP TABLE IF EXISTS backup_payload CASCADE');
    await db.query(`
      CREATE TABLE tags (
        id UUID PRIMARY KEY,
        slug TEXT NOT NULL,
        context TEXT NOT NULL,
        _meta_type TEXT NOT NULL,
        name TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        metadata TEXT NOT NULL DEFAULT '',
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        UNIQUE (slug, context, _meta_type)
      )
    `);
    await db.query('CREATE TABLE achievements (id UUID PRIMARY KEY)');
    await db.query(`
      CREATE TABLE achievement_tags (
        id TEXT PRIMARY KEY,
        achievement_id TEXT,
        tag_id TEXT,
        tag_role TEXT,
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
      )
    `);
    await db.query(
      `INSERT INTO tags (id, slug, context, _meta_type, name)
       VALUES (?, 'typescript', 'skill', '@happyvertical/smrt-tags:Tag', 'TypeScript')`,
      [TAG_ID],
    );
    await db.query('INSERT INTO achievements (id) VALUES (?)', [
      ACHIEVEMENT_ID,
    ]);
    await db.query(
      `
      INSERT INTO achievement_tags (id, achievement_id, tag_id, tag_role)
      VALUES
        ('join-existing', ?, 'typescript', 'skill'),
        ('join-create', ?, 'svelte', 'skill'),
        ('join-orphan', ?, 'typescript', 'skill')
    `,
      [ACHIEVEMENT_ID, ACHIEVEMENT_ID, MISSING_ACHIEVEMENT_ID],
    );
  });

  afterAll(async () => {
    if (!db) return;
    await db.query('DROP TABLE IF EXISTS data_repair_audit CASCADE');
    await db.query('DROP TABLE IF EXISTS data_repair_runs CASCADE');
    await db.query('DROP TABLE IF EXISTS achievement_tags CASCADE');
    await db.query('DROP TABLE IF EXISTS achievements CASCADE');
    await db.query('DROP TABLE IF EXISTS tags CASCADE');
    await db.query('DROP TABLE IF EXISTS backup_payload CASCADE');
  });

  it('rolls back drift and applies an audited, guarded canonical repair', async () => {
    const plan = await inspectTagIntegrity(db);
    expect(plan).toMatchObject({
      canonicalizations: expect.arrayContaining([
        expect.objectContaining({ rowId: 'join-existing' }),
        expect.objectContaining({ rowId: 'join-create' }),
      ]),
      collisions: [],
      orphanDeletes: [expect.objectContaining({ rowId: 'join-orphan' })],
      tagCreations: [
        expect.objectContaining({ context: 'skill', slug: 'svelte' }),
      ],
      unrepairable: [],
    });

    await expect(
      applyTagIntegrityRepair(db, {
        backupSha256: 'a'.repeat(64),
        expectedFingerprint: '0'.repeat(64),
      }),
    ).rejects.toThrow(/plan changed/u);
    await expect(
      db.query('SELECT count(*)::int AS count FROM tags'),
    ).resolves.toMatchObject({ rows: [{ count: 1 }] });

    await expect(
      applyTagIntegrityRepair(db, {
        backupSha256: 'a'.repeat(64),
        expectedFingerprint: plan.fingerprint,
      }),
    ).resolves.toMatchObject({
      canonicalizedRows: 2,
      createdTags: 1,
      deletedOrphans: 1,
    });

    const remaining = await inspectTagIntegrity(db);
    expect(remaining.canonicalizations).toHaveLength(0);
    expect(remaining.orphanDeletes).toHaveLength(0);
    expect(remaining.unrepairable).toHaveLength(0);
    const guards = await getTagIntegrityGuardStatus(db);
    expect(guards).toEqual({
      foreignKeysPresent: 2,
      foreignKeysTotal: 2,
      foreignKeysValidated: 2,
      requiredColumnsNotNull: 3,
      requiredColumnsTotal: 3,
      uniqueIndexesPresent: 1,
      uniqueIndexesTotal: 1,
    });
    await expect(
      db.query(
        "INSERT INTO achievement_tags (id, achievement_id, tag_id, tag_role) VALUES ('invalid', ?, '44444444-4444-4444-8444-444444444444', 'skill')",
        [ACHIEVEMENT_ID],
      ),
    ).rejects.toThrow();
    await expect(
      db.query(
        "INSERT INTO achievement_tags (id, achievement_id, tag_id, tag_role) VALUES ('null-role', ?, ?, NULL)",
        [ACHIEVEMENT_ID, TAG_ID],
      ),
    ).rejects.toThrow();
    await expect(
      db.query(
        'SELECT action, count(*)::int AS count FROM data_repair_audit GROUP BY action ORDER BY action',
      ),
    ).resolves.toMatchObject({
      rows: [
        { action: 'canonicalize_tag_id', count: 2 },
        { action: 'delete_orphan_join', count: 1 },
      ],
    });
    await expect(
      applyTagIntegrityRepair(db, {
        backupSha256: 'a'.repeat(64),
        expectedFingerprint: remaining.fingerprint,
      }),
    ).rejects.toThrow(/already recorded/u);
  });

  it('requires a full restore because a post-TOC truncation passes catalog verification', async () => {
    if (!databaseUrl)
      throw new Error('TAG_INTEGRITY_TEST_DATABASE_URL is required.');
    const root = await mkdtemp(join(tmpdir(), 'tag-integrity-backup-test-'));
    try {
      await db.query(
        `CREATE TABLE backup_payload AS
         SELECT n AS id, repeat(md5(n::text), 128) AS value
         FROM generate_series(1, 10000) n`,
      );
      const validDump = join(root, 'valid.dump');
      const truncatedDump = join(root, 'truncated.dump');
      await runPgDump(databaseUrl, validDump);
      await copyFile(validDump, truncatedDump);
      const dumpBytes = (await stat(truncatedDump)).size;
      expect(dumpBytes).toBeGreaterThan(4096);
      await truncate(truncatedDump, dumpBytes - 4096);

      await expect(verifyDatabaseDump(truncatedDump)).resolves.toMatchObject({
        dumpBytes: dumpBytes - 4096,
      });
      await expect(runPgRestore(databaseUrl, truncatedDump)).rejects.toThrow(
        /pg_restore exited with status/u,
      );
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });
});
