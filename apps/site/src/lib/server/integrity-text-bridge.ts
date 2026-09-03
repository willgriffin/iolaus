import type { resolveDatabase } from '@happyvertical/smrt-core';

type SmrtDatabase = Awaited<ReturnType<typeof resolveDatabase>>;

/**
 * Application-owned stored generated column mirroring a row id as `text`.
 *
 * `tag-integrity.ts` and `source-crawl-opportunity-integrity.ts` install it so
 * this application can enforce foreign keys between its own `text` reference
 * columns and parent tables whose `id` column type it does not own. SMRT
 * 0.44.0 (smrt#2611) converges those legacy `text` id columns to `uuid`, and
 * PostgreSQL refuses `ALTER COLUMN ... TYPE` while a stored generated column
 * depends on the column being altered:
 *
 *     cannot alter type of a column used by a generated column (0A000)
 *
 * The bridge is derived state, so the migration entry point releases it before
 * SMRT converges an id column and the existing post-migration guards
 * (`ensureTagIntegrityGuards`, `ensureSourceCrawlOpportunityGuard`) rebuild the
 * column, its unique index, and the dependent foreign keys against the new
 * column type inside the same migration advisory lock.
 */
export const INTEGRITY_TEXT_BRIDGE_COLUMN = '_integrity_id_text';

const ID_TYPE_CHANGE_PATTERN =
  /^\s*ALTER\s+TABLE\s+"([^"]+)"\s+ALTER\s+COLUMN\s+"id"\s+TYPE\s+/iu;

export interface IntegrityTextBridgeRelease {
  table: string;
  droppedConstraints: string[];
}

function quoteIdentifier(value: string): string {
  return `"${value.replace(/"/gu, '""')}"`;
}

function rowsOf(result: unknown): Record<string, unknown>[] {
  const rows = (result as { rows?: unknown })?.rows;
  return Array.isArray(rows) ? (rows as Record<string, unknown>[]) : [];
}

/**
 * Tables whose `id` column a pending schema statement converts to another type.
 *
 * Deriving the set from the planned statements keeps the release strictly
 * bounded to what SMRT is about to convert: once an id column is `uuid` the
 * conversion statement is no longer planned and nothing is released.
 */
export function planIntegrityTextBridgeReleases(
  statements: readonly string[],
): string[] {
  const tables = new Set<string>();
  for (const statement of statements) {
    const match = ID_TYPE_CHANGE_PATTERN.exec(statement);
    if (match?.[1]) tables.add(match[1]);
  }
  return [...tables].sort();
}

async function hasIntegrityTextBridge(
  db: SmrtDatabase,
  table: string,
): Promise<boolean> {
  const result = await db.query(
    `SELECT 1
     FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name = ?
       AND column_name = ?
     LIMIT 1`,
    [table, INTEGRITY_TEXT_BRIDGE_COLUMN],
  );
  return rowsOf(result).length > 0;
}

/**
 * Foreign keys referencing this table's bridge column, as `child table` and
 * `constraint name` pairs. They must be dropped before the column can be, and
 * the post-migration guards re-add each one as `NOT VALID` then validate it.
 */
async function listIntegrityTextBridgeDependents(
  db: SmrtDatabase,
  table: string,
): Promise<{ child: string; constraint: string }[]> {
  const result = await db.query(
    `SELECT child.relname AS child, con.conname AS constraint_name
     FROM pg_constraint con
     JOIN pg_class child ON child.oid = con.conrelid
     JOIN pg_class parent ON parent.oid = con.confrelid
     WHERE con.contype = 'f'
       AND parent.relname = ?
       AND EXISTS (
         SELECT 1
         FROM unnest(con.confkey) AS key
         JOIN pg_attribute att
           ON att.attrelid = con.confrelid AND att.attnum = key
         WHERE att.attname = ?
       )
     ORDER BY child.relname, con.conname`,
    [table, INTEGRITY_TEXT_BRIDGE_COLUMN],
  );
  return rowsOf(result).map((row) => ({
    child: String(row.child ?? ''),
    constraint: String(row.constraint_name ?? ''),
  }));
}

/**
 * Drop one table's bridge column and every foreign key depending on it.
 *
 * Returns `null` when the table has no bridge column, so a database that never
 * carried the legacy text drift is untouched.
 */
export async function releaseIntegrityTextBridge(
  db: SmrtDatabase,
  table: string,
): Promise<IntegrityTextBridgeRelease | null> {
  if (!(await hasIntegrityTextBridge(db, table))) return null;

  const dependents = await listIntegrityTextBridgeDependents(db, table);
  for (const dependent of dependents) {
    await db.query(
      `ALTER TABLE ${quoteIdentifier(dependent.child)}
       DROP CONSTRAINT IF EXISTS ${quoteIdentifier(dependent.constraint)}`,
    );
  }
  await db.query(
    `ALTER TABLE ${quoteIdentifier(table)}
     DROP COLUMN IF EXISTS ${quoteIdentifier(INTEGRITY_TEXT_BRIDGE_COLUMN)}`,
  );

  return {
    table,
    droppedConstraints: dependents.map((dependent) => dependent.constraint),
  };
}

/**
 * Release every bridge column blocking the supplied pending schema statements.
 *
 * Call this inside the migration advisory lock, immediately before applying the
 * statements, so no concurrent writer observes a table without its guards.
 */
export async function releaseIntegrityTextBridges(
  db: SmrtDatabase,
  statements: readonly string[],
): Promise<IntegrityTextBridgeRelease[]> {
  const releases: IntegrityTextBridgeRelease[] = [];
  for (const table of planIntegrityTextBridgeReleases(statements)) {
    const release = await releaseIntegrityTextBridge(db, table);
    if (release) releases.push(release);
  }
  return releases;
}

export function formatIntegrityTextBridgeReleases(
  releases: readonly IntegrityTextBridgeRelease[],
): string {
  if (releases.length === 0) {
    return 'No integrity text bridge columns needed release.';
  }
  return releases
    .map(
      (release) =>
        `Released ${INTEGRITY_TEXT_BRIDGE_COLUMN} on ${release.table} (dropped ${release.droppedConstraints.length} dependent foreign key${
          release.droppedConstraints.length === 1 ? '' : 's'
        }).`,
    )
    .join('\n');
}
