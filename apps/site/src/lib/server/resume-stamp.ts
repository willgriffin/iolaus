import { createHash } from 'node:crypto';
import {
  ObjectRegistry,
  resolveDatabase,
  type SmrtClassOptions,
} from '@happyvertical/smrt-core';
import { resumeStampClassNames } from './resume-read-plans.js';

export type ResumeStampDatabase = NonNullable<SmrtClassOptions['db']>;

type QueryResult =
  | { rows?: Record<string, unknown>[] }
  | Record<string, unknown>[];

/**
 * Postgres identifiers are interpolated, not parameterized, so anything reaching
 * the stamp query must look like a plain unquoted table name. The names come
 * from SMRT class metadata rather than user input, but a malformed override
 * should fail the stamp (and fall back to TTL) instead of reaching the database.
 *
 * Identifiers are additionally double-quoted at the call site, so a future table
 * named for a reserved word (`user`, `order`, `group`) cannot break the query.
 * The regex makes quoting semantically identical for every current name.
 */
const SAFE_TABLE_NAME = /^[a-z_][a-z0-9_]*$/;

function rowsFromResult(result: QueryResult): Record<string, unknown>[] {
  return Array.isArray(result) ? result : (result.rows ?? []);
}

/**
 * Resolve the read plan's classes to their real table names.
 *
 * Table names are read from the same SMRT registry the collections use, because
 * the mapping is not mechanical — `Education` is stored in `education`, not
 * `educations`, and `EmploymentPerson` overrides its table outright. A
 * hand-maintained list would silently drift from the read plan.
 */
export function resumeStampTableNames(): string[] {
  const tables = new Set<string>();
  for (const className of resumeStampClassNames()) {
    const tableName = ObjectRegistry.getTableName(className);
    if (!tableName) {
      throw new Error(
        `No registered table name for resume collection "${className}".`,
      );
    }
    if (!SAFE_TABLE_NAME.test(tableName)) {
      throw new Error(
        `Unsafe table name "${tableName}" for resume collection "${className}".`,
      );
    }
    tables.add(tableName);
  }
  return [...tables].sort();
}

function buildStampSql(tables: readonly string[]): string {
  return tables
    .map(
      (table) =>
        `SELECT '${table}' AS source_table, count(*) AS row_count, ` +
        `md5(coalesce(string_agg(id::text || ':' || xmin::text, ',' ORDER BY id::text), '')) AS row_digest ` +
        `FROM "${table}"`,
    )
    .join('\nUNION ALL\n');
}

function digestRows(rows: Record<string, unknown>[]): string {
  const canonical = rows
    .map((row) => {
      const table = String(row.source_table ?? '');
      const count = String(row.row_count ?? '0');
      const digest = String(row.row_digest ?? '');
      return `${table}:${count}:${digest}`;
    })
    .sort()
    .join('|');
  return createHash('sha256').update(canonical).digest('hex');
}

/**
 * Compute a version stamp for the published resume in one database round-trip.
 *
 * Per table the stamp combines `count(*)` with an order-independent digest over
 * every row's `(id, xmin)` pair. `xmin` is Postgres's system column holding the
 * transaction that last wrote the row, so it changes on *every* update by
 * construction — no timestamp is consulted at all.
 *
 * That choice is deliberate. Timestamps cannot carry this:
 *   - SMRT stamps `updated_at` from the writing pod's own clock, so under
 *     replica clock skew an edit can land below the current maximum;
 *   - two saves in the same millisecond produce an identical `updated_at`;
 *   - raw SQL that edits a row without setting `updated_at` moves nothing.
 * Each of those leaves a timestamp-derived stamp unmoved while the content has
 * changed, stranding the other replica on stale data. `xmin` has none of these
 * failure modes: any write, from any source, by any clock, moves it.
 *
 * The reverse — `xmin` moving without a content change, after a wraparound
 * freeze or `VACUUM FREEZE` — costs one redundant reload, which is the safe
 * direction.
 *
 * Because the stamp is derived from the rows themselves, no writer has to
 * remember to bump anything: the admin editor, the backfill scripts, a psql
 * session, and a restored dump all invalidate the cache for free, and every
 * replica observes the same value without cross-process messaging.
 */
export async function loadPublishedResumeStamp(
  database: ResumeStampDatabase,
): Promise<string> {
  const tables = resumeStampTableNames();
  const db = await resolveDatabase(database);
  const result = (await db.query(buildStampSql(tables))) as QueryResult;
  const rows = rowsFromResult(result);

  // `rowsFromResult` hedges across two driver result shapes. A third would fall
  // through to `[]`, and an empty digest is a *constant* — it would validate on
  // every probe and pin every non-writing replica as permanently fresh. That is
  // the one failure mode here that is both silent and unsafe, so require the row
  // count the query must have produced and let anything else raise, which the
  // caller already degrades safely.
  if (rows.length !== tables.length) {
    throw new Error(
      `Resume stamp query returned ${rows.length} rows for ${tables.length} tables.`,
    );
  }

  // Check the identities too, not just the count. A result keyed differently
  // than expected would coalesce every field to the same empty values and digest
  // to a constant — the same permanently-fresh failure the count guard exists to
  // prevent, just reached by a different route.
  const returned = new Set(rows.map((row) => String(row.source_table ?? '')));
  for (const table of tables) {
    if (!returned.has(table)) {
      throw new Error(`Resume stamp query omitted table "${table}".`);
    }
  }

  return digestRows(rows);
}
