import { randomUUID } from 'node:crypto';
import { resolveDatabase } from '@happyvertical/smrt-core';
import { afterEach, describe, expect, it } from 'vitest';
import {
  AUTH_UNIQUE_INDEXES,
  ensureNativeAuthUniqueIndexes,
} from './auth-unique-indexes.js';
import { getDbConfig } from './db.js';

type SmrtDatabase = Awaited<ReturnType<typeof resolveDatabase>>;

let db: SmrtDatabase | undefined;
let schemaName: string | undefined;

function quoteIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

function quoteLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

function currentSchema(): string {
  if (!schemaName) {
    throw new Error('Expected a PostgreSQL test schema.');
  }
  return quoteIdentifier(schemaName);
}

async function scopedDatabase() {
  db = await resolveDatabase(getDbConfig());
  schemaName = `auth_unique_index_test_${randomUUID().replaceAll('-', '')}`;
  const schema = quoteIdentifier(schemaName);
  await db.query(`CREATE SCHEMA ${schema}`);
  await db.query(`
    CREATE TABLE ${schema}.users (
      id uuid PRIMARY KEY,
      profile_id uuid
    );
    CREATE TABLE ${schema}.users_cli_auth_requests (
      id uuid PRIMARY KEY,
      device_code_hash text,
      user_code text
    );
    CREATE INDEX users_profile_id_idx ON ${schema}.users (profile_id);
    CREATE INDEX users_cli_auth_requests_device_code_hash_idx
      ON ${schema}.users_cli_auth_requests (device_code_hash);
    CREATE INDEX users_cli_auth_requests_user_code_idx
      ON ${schema}.users_cli_auth_requests (user_code);
  `);
  return {
    acquireSession: async () => {
      const session = await db?.acquireSession?.();
      if (!session) throw new Error('Expected a PostgreSQL test session.');
      await session.query(`SET search_path TO ${schema}, public`);
      return session;
    },
  };
}

async function indexState(index: string): Promise<Record<string, unknown>> {
  if (!schemaName) {
    throw new Error('Expected a PostgreSQL test schema.');
  }
  const result = await db?.query(`
    SELECT index_definition.indisvalid AS "valid",
           index_definition.indisunique AS "unique",
           index_definition.indpred IS NULL AS "full"
    FROM pg_index AS index_definition
    JOIN pg_class AS index_relation
      ON index_relation.oid = index_definition.indexrelid
    JOIN pg_namespace AS schema_relation
      ON schema_relation.oid = index_relation.relnamespace
    WHERE schema_relation.nspname = ${quoteLiteral(schemaName)}
      AND index_relation.relname = ${quoteLiteral(index)}
  `);
  const rows = Array.isArray(result)
    ? result
    : ((result as { rows?: Record<string, unknown>[] })?.rows ?? []);
  return rows[0] ?? {};
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
  'native auth uniqueness persistence',
  () => {
    it('creates exact full unique indexes, preserves plain indexes, and is idempotent', async () => {
      const scoped = await scopedDatabase();

      await ensureNativeAuthUniqueIndexes(scoped as never);
      await ensureNativeAuthUniqueIndexes(scoped as never);

      for (const { index } of AUTH_UNIQUE_INDEXES) {
        await expect(indexState(index)).resolves.toEqual({
          full: true,
          unique: true,
          valid: true,
        });
      }
      for (const index of [
        'users_profile_id_idx',
        'users_cli_auth_requests_device_code_hash_idx',
        'users_cli_auth_requests_user_code_idx',
      ]) {
        await expect(indexState(index)).resolves.toEqual({
          full: true,
          unique: false,
          valid: true,
        });
      }
    });

    it('preserves PostgreSQL null uniqueness semantics for every guarded column', async () => {
      const scoped = await scopedDatabase();
      const schema = currentSchema();
      await db?.query(`
        INSERT INTO ${schema}.users (id, profile_id) VALUES
          ('00000000-0000-0000-0000-000000000001', NULL),
          ('00000000-0000-0000-0000-000000000002', NULL);
        INSERT INTO ${schema}.users_cli_auth_requests (id, device_code_hash, user_code) VALUES
          ('00000000-0000-0000-0000-000000000003', NULL, NULL),
          ('00000000-0000-0000-0000-000000000004', NULL, NULL);
      `);

      await expect(
        ensureNativeAuthUniqueIndexes(scoped as never),
      ).resolves.toBeUndefined();
      for (const { index } of AUTH_UNIQUE_INDEXES) {
        await expect(indexState(index)).resolves.toEqual({
          full: true,
          unique: true,
          valid: true,
        });
      }
    });

    it.each([
      {
        column: 'profile_id',
        table: 'users',
        value: '10000000-0000-0000-0000-000000000099',
      },
      {
        column: 'device_code_hash',
        table: 'users_cli_auth_requests',
        value: 'duplicate-device-code',
      },
      {
        column: 'user_code',
        table: 'users_cli_auth_requests',
        value: 'duplicate-user-code',
      },
    ])('refuses duplicate $column values without deleting rows', async ({
      column,
      table,
      value,
    }) => {
      const scoped = await scopedDatabase();
      const schema = currentSchema();
      await db?.query(`
          INSERT INTO ${schema}.${table} (id, ${column}) VALUES
            ('00000000-0000-0000-0000-000000000001', ${quoteLiteral(value)}),
            ('00000000-0000-0000-0000-000000000002', ${quoteLiteral(value)});
        `);

      await expect(
        ensureNativeAuthUniqueIndexes(scoped as never),
      ).rejects.toThrow('duplicate non-null values exist');
      const count = await db?.query(
        `SELECT count(*)::int AS "count" FROM ${schema}.${table}`,
      );
      const rows = Array.isArray(count)
        ? count
        : ((count as { rows?: Record<string, unknown>[] })?.rows ?? []);
      expect(rows[0]?.count).toBe(2);
    });

    it.each(
      AUTH_UNIQUE_INDEXES,
    )('fails closed for a same-name non-unique %s index without dropping it', async ({
      column,
      index,
      table,
    }) => {
      const scoped = await scopedDatabase();
      const schema = currentSchema();
      await db?.query(
        `CREATE INDEX ${quoteIdentifier(index)} ON ${schema}.${quoteIdentifier(table)} (${quoteIdentifier(column)})`,
      );

      await expect(
        ensureNativeAuthUniqueIndexes(scoped as never),
      ).rejects.toThrow('required valid unique auth index');
      await expect(indexState(index)).resolves.toEqual({
        full: true,
        unique: false,
        valid: true,
      });
    });

    it('fails closed for a same-name partial index without replacing it', async () => {
      const scoped = await scopedDatabase();
      const schema = currentSchema();
      await db?.query(
        `CREATE UNIQUE INDEX users_profile_id_uidx ON ${schema}.users (profile_id) WHERE profile_id IS NOT NULL`,
      );

      await expect(
        ensureNativeAuthUniqueIndexes(scoped as never),
      ).rejects.toThrow('required valid unique auth index');
      await expect(indexState('users_profile_id_uidx')).resolves.toEqual({
        full: false,
        unique: true,
        valid: true,
      });
    });

    it('fails closed for a same-name UNIQUE NULLS NOT DISTINCT index', async () => {
      const scoped = await scopedDatabase();
      const schema = currentSchema();
      await db?.query(
        `CREATE UNIQUE INDEX users_profile_id_uidx ON ${schema}.users (profile_id) NULLS NOT DISTINCT`,
      );

      await expect(
        ensureNativeAuthUniqueIndexes(scoped as never),
      ).rejects.toThrow('required valid unique auth index');
      await expect(indexState('users_profile_id_uidx')).resolves.toEqual({
        full: true,
        unique: true,
        valid: true,
      });
    });
  },
);
