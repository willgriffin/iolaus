import { randomUUID } from 'node:crypto';
import type { getTestDatabase } from '@happyvertical/smrt-core';

type TestDatabase = Awaited<ReturnType<typeof getTestDatabase>>;

interface RequiredColumn {
  name: string;
  type: string;
}

const requiredCache = new WeakMap<object, Map<string, RequiredColumn[]>>();

/** NOT NULL columns without a default, so fixtures can satisfy any schema. */
async function requiredColumns(
  db: TestDatabase,
  table: string,
): Promise<RequiredColumn[]> {
  const perDb = requiredCache.get(db) ?? new Map<string, RequiredColumn[]>();
  requiredCache.set(db, perDb);
  const cached = perDb.get(table);
  if (cached) return cached;
  const isPostgres = Boolean(
    (db as { url?: string }).url?.startsWith('postgres'),
  );
  const found = isPostgres
    ? ((
        await db.query(
          `SELECT column_name AS name, data_type AS type FROM information_schema.columns
            WHERE table_schema = current_schema() AND table_name = ?
              AND is_nullable = 'NO' AND column_default IS NULL`,
          [table],
        )
      ).rows as RequiredColumn[])
    : (
        (await db.query(`PRAGMA table_info("${table}")`)).rows as Array<{
          dflt_value: unknown;
          name: string;
          notnull: number;
          pk: number;
          type: string;
        }>
      )
        .filter((column) => column.notnull === 1 && column.dflt_value === null)
        .map((column) => ({ name: column.name, type: column.type }));
  perDb.set(table, found);
  return found;
}

function placeholder(type: string): unknown {
  const lower = type.toLowerCase();
  if (/int|numeric|decimal|real|double/u.test(lower)) return 0;
  if (/time|date/u.test(lower)) return '2026-10-05T00:00:00.000Z';
  if (/bool/u.test(lower)) return false;
  if (/json/u.test(lower)) return '{}';
  return randomUUID();
}

/** Insert one row, filling every NOT NULL column that has no default. */
export async function insert(
  db: TestDatabase,
  table: string,
  values: Record<string, unknown>,
): Promise<void> {
  const id = randomUUID();
  const row: Record<string, unknown> = {
    id,
    slug: id,
    context: '',
    ...values,
  };
  for (const column of await requiredColumns(db, table)) {
    if (!(column.name in row)) row[column.name] = placeholder(column.type);
  }
  const columns = Object.keys(row);
  await db.query(
    `INSERT INTO "${table}" (${columns.map((column) => `"${column}"`).join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`,
    Object.values(row),
  );
}
