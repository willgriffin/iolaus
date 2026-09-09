import { resolveDatabase } from '@happyvertical/smrt-core';
import { getDbConfig } from './db.js';

export const AUTH_UNIQUE_INDEXES = [
  {
    column: 'profile_id',
    index: 'users_profile_id_uidx',
    table: 'users',
  },
  {
    column: 'device_code_hash',
    index: 'users_cli_auth_requests_device_code_hash_uidx',
    table: 'users_cli_auth_requests',
  },
  {
    column: 'user_code',
    index: 'users_cli_auth_requests_user_code_uidx',
    table: 'users_cli_auth_requests',
  },
] as const;

const AUTH_UNIQUE_INDEX_LOCK_TIMEOUT = '15s';
const AUTH_UNIQUE_INDEX_STATEMENT_TIMEOUT = '60s';

type SmrtDatabase = Awaited<ReturnType<typeof resolveDatabase>>;

function quoteIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

function quoteLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

function assertionSql({
  column,
  index,
  table,
}: (typeof AUTH_UNIQUE_INDEXES)[number]) {
  const expectedColumns = `ARRAY[${quoteLiteral(column)}]::name[]`;
  const tableName = quoteIdentifier(table);

  return `
    DO $$
    BEGIN
      IF EXISTS (
        SELECT 1
        FROM pg_class AS index_relation
        WHERE index_relation.relname = ${quoteLiteral(index)}
          AND index_relation.relnamespace = current_schema()::regnamespace
      )
      AND NOT EXISTS (
        SELECT 1
        FROM pg_index AS index_definition
        JOIN pg_class AS index_relation
          ON index_relation.oid = index_definition.indexrelid
        JOIN pg_class AS table_relation
          ON table_relation.oid = index_definition.indrelid
        WHERE table_relation.oid = ${quoteLiteral(table)}::regclass
          AND index_relation.relname = ${quoteLiteral(index)}
          AND index_relation.relnamespace = current_schema()::regnamespace
          AND index_definition.indisvalid
          AND index_definition.indisunique
          AND index_definition.indimmediate
          AND index_definition.indpred IS NULL
          AND NOT index_definition.indnullsnotdistinct
          AND index_definition.indnkeyatts = 1
          AND (
            SELECT array_agg(attribute.attname ORDER BY key_column.ordinality)
            FROM unnest(index_definition.indkey) WITH ORDINALITY AS key_column(attnum, ordinality)
            JOIN pg_attribute AS attribute
              ON attribute.attrelid = index_definition.indrelid
             AND attribute.attnum = key_column.attnum
            WHERE key_column.ordinality <= index_definition.indnkeyatts
          ) = ${expectedColumns}
      ) THEN
        RAISE EXCEPTION
          'Index % exists but is not the required valid unique auth index for %.%',
          ${quoteLiteral(index)}, ${quoteLiteral(table)}, ${quoteLiteral(column)};
      END IF;

      IF EXISTS (
        SELECT 1
        FROM ${tableName}
        WHERE ${quoteIdentifier(column)} IS NOT NULL
        GROUP BY ${quoteIdentifier(column)}
        HAVING count(*) > 1
      ) THEN
        RAISE EXCEPTION
          'Cannot create unique auth index %.%: duplicate non-null values exist',
          ${quoteLiteral(table)}, ${quoteLiteral(column)};
      END IF;
    END
    $$
  `;
}

function verifySql({
  column,
  index,
  table,
}: (typeof AUTH_UNIQUE_INDEXES)[number]) {
  const expectedColumns = `ARRAY[${quoteLiteral(column)}]::name[]`;

  return `
    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1
        FROM pg_index AS index_definition
        JOIN pg_class AS index_relation
          ON index_relation.oid = index_definition.indexrelid
        JOIN pg_class AS table_relation
          ON table_relation.oid = index_definition.indrelid
        WHERE table_relation.oid = ${quoteLiteral(table)}::regclass
          AND index_relation.relname = ${quoteLiteral(index)}
          AND index_relation.relnamespace = current_schema()::regnamespace
          AND index_definition.indisvalid
          AND index_definition.indisunique
          AND index_definition.indimmediate
          AND index_definition.indpred IS NULL
          AND NOT index_definition.indnullsnotdistinct
          AND index_definition.indnkeyatts = 1
          AND (
            SELECT array_agg(attribute.attname ORDER BY key_column.ordinality)
            FROM unnest(index_definition.indkey) WITH ORDINALITY AS key_column(attnum, ordinality)
            JOIN pg_attribute AS attribute
              ON attribute.attrelid = index_definition.indrelid
             AND attribute.attnum = key_column.attnum
            WHERE key_column.ordinality <= index_definition.indnkeyatts
          ) = ${expectedColumns}
      ) THEN
        RAISE EXCEPTION
          'Missing valid unique auth index % for %.%',
          ${quoteLiteral(index)}, ${quoteLiteral(table)}, ${quoteLiteral(column)};
      END IF;
    END
    $$
  `;
}

/**
 * Restore the three full unique indexes declared by the released SMRT users
 * contract. Existing differently named plain indexes are intentionally left in
 * place: dropping an operator-created access path is outside this migration.
 *
 * Nulls remain permitted where PostgreSQL UNIQUE permits them. Any duplicate
 * non-null value, or an existing named index of the wrong shape, fails the
 * migration before it can alter data or replace an index.
 */
export async function ensureNativeAuthUniqueIndexes(
  db?: SmrtDatabase,
): Promise<void> {
  const database = db ?? (await resolveDatabase(getDbConfig()));
  if (typeof database.acquireSession !== 'function') {
    throw new Error(
      'Native auth uniqueness compatibility requires a PostgreSQL session.',
    );
  }

  const session = await database.acquireSession();
  let committed = false;
  try {
    await session.query('BEGIN');
    await session.query("SELECT set_config('lock_timeout', $1, true)", [
      AUTH_UNIQUE_INDEX_LOCK_TIMEOUT,
    ]);
    await session.query("SELECT set_config('statement_timeout', $1, true)", [
      AUTH_UNIQUE_INDEX_STATEMENT_TIMEOUT,
    ]);
    for (const table of new Set(
      AUTH_UNIQUE_INDEXES.map(({ table }) => table),
    )) {
      await session.query(
        `LOCK TABLE ${quoteIdentifier(table)} IN ACCESS EXCLUSIVE MODE`,
      );
    }
    for (const target of AUTH_UNIQUE_INDEXES) {
      await session.query(assertionSql(target));
    }
    for (const target of AUTH_UNIQUE_INDEXES) {
      await session.query(
        `CREATE UNIQUE INDEX IF NOT EXISTS ${quoteIdentifier(target.index)}
         ON ${quoteIdentifier(target.table)} (${quoteIdentifier(target.column)})`,
      );
    }
    for (const target of AUTH_UNIQUE_INDEXES) {
      await session.query(verifySql(target));
    }
    await session.query('COMMIT');
    committed = true;
  } catch (error) {
    if (!committed) {
      try {
        await session.query('ROLLBACK');
      } catch {
        // Preserve the original migration error.
      }
    }
    throw error;
  } finally {
    await session.release();
  }
}
