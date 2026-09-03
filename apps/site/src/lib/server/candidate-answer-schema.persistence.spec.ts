import { randomUUID } from 'node:crypto';
import { resolveDatabase } from '@happyvertical/smrt-core';
import { afterEach, describe, expect, it } from 'vitest';
import {
  CANDIDATE_ANSWER_NATURAL_KEY_INDEX,
  ensureCandidateAnswerNaturalKeyIndex,
  repairExistingCandidateAnswerNaturalKeyIndex,
} from './candidate-answer-schema.js';
import { getDbConfig } from './db.js';

type SmrtDatabase = Awaited<ReturnType<typeof resolveDatabase>>;

let db: SmrtDatabase | undefined;
let schemaName: string | undefined;

function quoteIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

function resultRows(result: unknown): Record<string, unknown>[] {
  if (Array.isArray(result)) return result as Record<string, unknown>[];
  if (
    result &&
    typeof result === 'object' &&
    Array.isArray((result as { rows?: unknown }).rows)
  ) {
    return (result as { rows: Record<string, unknown>[] }).rows;
  }
  return [];
}

afterEach(async () => {
  if (db && schemaName) {
    await db.query(
      `DROP SCHEMA IF EXISTS ${quoteIdentifier(schemaName)} CASCADE`,
    );
  }
  await db?.close?.();
  db = undefined;
  schemaName = undefined;
});

describe.skipIf(!process.env.DATABASE_URL)(
  'CandidateAnswer schema compatibility persistence',
  () => {
    it('skips the legacy pre-pass when the CandidateAnswer table is not yet created', async () => {
      db = await resolveDatabase(getDbConfig());
      schemaName = `candidate_answer_schema_test_${randomUUID().replaceAll('-', '')}`;
      const schema = quoteIdentifier(schemaName);

      await db.query(`CREATE SCHEMA ${schema}`);
      const scopedDatabase = {
        acquireSession: async () => {
          const session = await db?.acquireSession?.();
          if (!session) throw new Error('Expected a PostgreSQL test session.');
          await session.query(`SET search_path TO ${schema}, public`);
          return session;
        },
        query: (statement: string) =>
          db
            ?.query(`SET search_path TO ${schema}, public`)
            .then(() => db?.query(statement)),
      };

      await expect(
        repairExistingCandidateAnswerNaturalKeyIndex(scopedDatabase as never),
      ).resolves.toBeUndefined();
    });

    it('rejects a deferrable key that PostgreSQL cannot use for an upsert', async () => {
      db = await resolveDatabase(getDbConfig());
      schemaName = `candidate_answer_schema_test_${randomUUID().replaceAll('-', '')}`;
      const schema = quoteIdentifier(schemaName);

      await db.query(`CREATE SCHEMA ${schema}`);
      await db.query(`
      CREATE TABLE ${schema}.candidate_answers (
        id UUID PRIMARY KEY,
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        profile_key TEXT NOT NULL,
        label_key TEXT NOT NULL
      )
    `);
      await db.query(`
      ALTER TABLE ${schema}.candidate_answers
        ADD CONSTRAINT ${CANDIDATE_ANSWER_NATURAL_KEY_INDEX}
        UNIQUE (profile_key, label_key) DEFERRABLE INITIALLY IMMEDIATE
    `);

      const scopedDatabase = {
        acquireSession: async () => {
          const session = await db?.acquireSession?.();
          if (!session) throw new Error('Expected a PostgreSQL test session.');
          await session.query(`SET search_path TO ${schema}, public`);
          return session;
        },
      };

      await expect(
        ensureCandidateAnswerNaturalKeyIndex(scopedDatabase as never),
      ).rejects.toThrow('Failed to execute session query');
    });

    it('preserves nullable legacy rows while making the complete natural key upsertable', async () => {
      db = await resolveDatabase(getDbConfig());
      schemaName = `candidate_answer_schema_test_${randomUUID().replaceAll('-', '')}`;
      const schema = quoteIdentifier(schemaName);

      await db.query(`CREATE SCHEMA ${schema}`);
      await db.query(`
      CREATE TABLE ${schema}.candidate_answers (
        id UUID PRIMARY KEY,
        slug TEXT NOT NULL,
        context TEXT NOT NULL DEFAULT '',
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        profile_key TEXT,
        label TEXT,
        label_key TEXT,
        value TEXT,
        active BOOLEAN
      )
    `);
      await db.query(`
      CREATE UNIQUE INDEX candidate_answers_slug_context_idx
        ON ${schema}.candidate_answers (slug, context)
    `);
      await db.query(`
      INSERT INTO ${schema}.candidate_answers (
        id, slug, profile_key, label, label_key, value, active, created_at, updated_at
      ) VALUES
        ('00000000-0000-0000-0000-000000000001', 'legacy-one', 'default', 'Known answer', 'known answer', 'older', TRUE, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z'),
        ('00000000-0000-0000-0000-000000000002', 'legacy-two', 'default', 'Known answer', 'known answer', 'newer', TRUE, '2026-01-02T00:00:00Z', '2026-01-02T00:00:00Z'),
        ('00000000-0000-0000-0000-000000000003', 'missing-profile-one', NULL, 'Incomplete profile', 'incomplete profile', 'keep one', TRUE, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z'),
        ('00000000-0000-0000-0000-000000000004', 'missing-profile-two', NULL, 'Incomplete profile', 'incomplete profile', 'keep two', TRUE, '2026-01-02T00:00:00Z', '2026-01-02T00:00:00Z'),
        ('00000000-0000-0000-0000-000000000005', 'missing-label-key-one', 'default', 'Incomplete key', NULL, 'keep three', TRUE, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z'),
        ('00000000-0000-0000-0000-000000000006', 'missing-label-key-two', 'default', 'Incomplete key', NULL, 'keep four', TRUE, '2026-01-02T00:00:00Z', '2026-01-02T00:00:00Z')
    `);

      const scopedDatabase = {
        acquireSession: async () => {
          const session = await db?.acquireSession?.();
          if (!session) throw new Error('Expected a PostgreSQL test session.');
          await session.query(`SET search_path TO ${schema}, public`);
          return session;
        },
      };
      await ensureCandidateAnswerNaturalKeyIndex(scopedDatabase as never);
      await ensureCandidateAnswerNaturalKeyIndex(scopedDatabase as never);

      const saved = resultRows(
        await db.query(`
        SELECT id, profile_key, label_key, value
        FROM ${schema}.candidate_answers
        ORDER BY id
      `),
      );
      expect(saved).toHaveLength(5);
      expect(saved.map((row) => row.id)).not.toContain(
        '00000000-0000-0000-0000-000000000001',
      );
      expect(saved).toContainEqual(
        expect.objectContaining({
          id: '00000000-0000-0000-0000-000000000002',
          value: 'newer',
        }),
      );
      expect(saved.filter((row) => row.profile_key === null)).toHaveLength(2);
      expect(saved.filter((row) => row.label_key === null)).toHaveLength(2);

      const indexes = resultRows(
        await db.query(`
        SELECT indexdef
        FROM pg_indexes
        WHERE schemaname = '${schemaName}'
          AND tablename = 'candidate_answers'
          AND indexname = '${CANDIDATE_ANSWER_NATURAL_KEY_INDEX}'
      `),
      );
      expect(indexes).toEqual([
        expect.objectContaining({
          indexdef: expect.stringContaining('(profile_key, label_key)'),
        }),
      ]);

      await db.query(`
      INSERT INTO ${schema}.candidate_answers (
        id, slug, profile_key, label, label_key, value, active
      ) VALUES (
        '00000000-0000-0000-0000-000000000007',
        'upserted',
        'default',
        'Known answer',
        'known answer',
        'updated through ON CONFLICT',
        TRUE
      )
      ON CONFLICT (profile_key, label_key)
      DO UPDATE SET value = EXCLUDED.value
    `);
      const upserted = resultRows(
        await db.query(`
        SELECT value
        FROM ${schema}.candidate_answers
        WHERE id = '00000000-0000-0000-0000-000000000002'
      `),
      );
      expect(upserted).toEqual([
        expect.objectContaining({ value: 'updated through ON CONFLICT' }),
      ]);
    });

    it('rebuilds an invalid interrupted index before making legacy keys upsertable', async () => {
      db = await resolveDatabase(getDbConfig());
      schemaName = `candidate_answer_schema_test_${randomUUID().replaceAll('-', '')}`;
      const schema = quoteIdentifier(schemaName);

      await db.query(`CREATE SCHEMA ${schema}`);
      await db.query(`
      CREATE TABLE ${schema}.candidate_answers (
        id UUID PRIMARY KEY,
        slug TEXT NOT NULL,
        context TEXT NOT NULL DEFAULT '',
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        profile_key TEXT,
        label_key TEXT,
        value TEXT
      )
    `);
      await db.query(`
      INSERT INTO ${schema}.candidate_answers (
        id, slug, profile_key, label_key, value
      ) VALUES
        ('00000000-0000-0000-0000-000000000011', 'legacy-one', 'default', 'known answer', 'older'),
        ('00000000-0000-0000-0000-000000000012', 'legacy-two', 'default', 'known answer', 'newer')
    `);
      await expect(
        db.query(`
        CREATE UNIQUE INDEX CONCURRENTLY ${schema}.${CANDIDATE_ANSWER_NATURAL_KEY_INDEX}
          ON ${schema}.candidate_answers (profile_key, label_key)
      `),
      ).rejects.toThrow();

      const scopedDatabase = {
        acquireSession: async () => {
          const session = await db?.acquireSession?.();
          if (!session) throw new Error('Expected a PostgreSQL test session.');
          await session.query(`SET search_path TO ${schema}, public`);
          return session;
        },
      };
      await ensureCandidateAnswerNaturalKeyIndex(scopedDatabase as never);

      const indexState = resultRows(
        await db.query(`
        SELECT index_definition.indisvalid AS "isValid"
        FROM pg_index AS index_definition
        JOIN pg_class AS index_relation
          ON index_relation.oid = index_definition.indexrelid
        JOIN pg_namespace AS namespace
          ON namespace.oid = index_relation.relnamespace
        WHERE namespace.nspname = '${schemaName}'
          AND index_relation.relname = '${CANDIDATE_ANSWER_NATURAL_KEY_INDEX}'
      `),
      );
      expect(indexState).toEqual([expect.objectContaining({ isValid: true })]);

      await db.query(`
      INSERT INTO ${schema}.candidate_answers (
        id, slug, profile_key, label_key, value
      ) VALUES (
        '00000000-0000-0000-0000-000000000013',
        'upserted',
        'default',
        'known answer',
        'updated through rebuilt index'
      )
      ON CONFLICT (profile_key, label_key)
      DO UPDATE SET value = EXCLUDED.value
    `);
      const saved = resultRows(
        await db.query(`
        SELECT id, value
        FROM ${schema}.candidate_answers
        ORDER BY id
      `),
      );
      expect(saved).toEqual([
        expect.objectContaining({
          id: '00000000-0000-0000-0000-000000000012',
          value: 'updated through rebuilt index',
        }),
      ]);
    });
  },
);
