import {
  assertWorkspaceOwnershipTableMappings,
  type WorkspaceOwnershipDatabase,
  type WorkspaceOwnershipDialect,
  workspaceOwnershipMixedLedgerTables,
  workspaceOwnershipTables,
} from './workspace-ownership-backfill.js';

type QueryResult =
  | { rows?: Array<Record<string, unknown>> }
  | Array<Record<string, unknown>>;

export interface WorkspaceOwnershipSchemaTableStatus {
  addedColumns: string[];
  columns: string[];
  /** A model introduced after the legacy snapshot needs native empty-table DDL. */
  needsNativeCreate: boolean;
  table: string;
  tablePresent: boolean;
}

function rows(result: QueryResult): Array<Record<string, unknown>> {
  return Array.isArray(result) ? result : (result.rows ?? []);
}

function quotedIdentifier(value: string): string {
  if (!/^[a-z][a-z0-9_]*$/u.test(value)) {
    throw new Error('Workspace ownership schema identifier is invalid.');
  }
  return `"${value}"`;
}

function ownershipColumns(table: string): readonly string[] {
  return table === 'candidate_profiles'
    ? ['tenant_id', 'owner_user_id']
    : ['tenant_id', 'owner_user_id', 'candidate_profile_id'];
}

/** Queryable, nullable assessment projections are added before legacy rows are
 * reranked. They stay nullable until the subject-bound freshness pass writes
 * current values; missing values deliberately mean unknown. */
function additiveColumns(table: string): readonly string[] {
  if (table !== 'opportunity_assessments') return ownershipColumns(table);
  return [
    ...ownershipColumns(table),
    'eligibility_bucket',
    'eligibility_priority',
    'fit_score',
    'excluded',
    'preferences_fingerprint',
  ];
}

function additiveColumnType(table: string, column: string): string {
  if (table !== 'opportunity_assessments') return 'TEXT';
  switch (column) {
    case 'eligibility_priority':
    case 'fit_score':
      return 'INTEGER';
    case 'excluded':
      return 'BOOLEAN';
    default:
      return 'TEXT';
  }
}

async function tableExists(
  database: WorkspaceOwnershipDatabase,
  dialect: WorkspaceOwnershipDialect,
  table: string,
): Promise<boolean> {
  if (dialect === 'sqlite') {
    const result = await database.query(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?",
      [table],
    );
    return rows(result).length === 1;
  }
  const result = await database.query('SELECT to_regclass(?) AS "tableName"', [
    table,
  ]);
  return typeof rows(result)[0]?.tableName === 'string';
}

async function existingColumns(
  database: WorkspaceOwnershipDatabase,
  dialect: WorkspaceOwnershipDialect,
  table: string,
): Promise<Set<string>> {
  if (dialect === 'sqlite') {
    const result = await database.query(
      `PRAGMA table_info(${quotedIdentifier(table)})`,
    );
    return new Set(rows(result).map((row) => String(row.name ?? '')));
  }
  const result = await database.query(
    `SELECT a.attname AS "columnName"
       FROM pg_attribute a
      WHERE a.attrelid = to_regclass(?)
        AND a.attnum > 0
        AND NOT a.attisdropped`,
    [table],
  );
  return new Set(rows(result).map((row) => String(row.columnName ?? '')));
}

/**
 * Phase one of a legacy private upgrade. It adds only nullable text columns;
 * it creates no index, constraint, trigger, or default and never changes row
 * values. A reviewed backfill must run before the later native enforcement.
 */
export async function prepareWorkspaceOwnershipSchema(
  database: WorkspaceOwnershipDatabase,
  dialect: WorkspaceOwnershipDialect,
  tables: readonly string[] = workspaceOwnershipTables,
): Promise<WorkspaceOwnershipSchemaTableStatus[]> {
  assertWorkspaceOwnershipTableMappings();
  const statuses: WorkspaceOwnershipSchemaTableStatus[] = [];
  for (const table of tables) {
    if (!(await tableExists(database, dialect, table))) {
      statuses.push({
        addedColumns: [],
        columns: [],
        needsNativeCreate: true,
        table,
        tablePresent: false,
      });
      continue;
    }
    const columns = await existingColumns(database, dialect, table);
    const addedColumns: string[] = [];
    for (const column of additiveColumns(table)) {
      if (columns.has(column)) continue;
      const statement =
        dialect === 'sqlite'
          ? `ALTER TABLE ${quotedIdentifier(table)} ADD COLUMN ${quotedIdentifier(column)} ${additiveColumnType(table, column)}`
          : `ALTER TABLE ${quotedIdentifier(table)} ADD COLUMN IF NOT EXISTS ${quotedIdentifier(column)} ${additiveColumnType(table, column)} NULL`;
      await database.query(statement);
      columns.add(column);
      addedColumns.push(column);
    }
    statuses.push({
      addedColumns,
      columns: [...columns].sort(),
      needsNativeCreate: false,
      table,
      tablePresent: true,
    });
  }
  return statuses;
}

export interface WorkspaceOwnershipEnforcementStatus {
  invalidOwnershipTuples: number;
  missingColumns: string[];
  missingUniqueIndexes: string[];
  nullableColumns: string[];
  table: string;
  tablePresent: boolean;
}

function requiredUniqueColumns(table: string): readonly string[] | null {
  if (table === 'candidate_profiles') {
    return ['tenant_id', 'owner_user_id', 'profile_key'];
  }
  if (table === 'opportunity_assessments') {
    return [
      'tenant_id',
      'owner_user_id',
      'candidate_profile_id',
      'opportunity_id',
      'assessment_fingerprint',
    ];
  }
  return null;
}

async function hasRequiredUniqueIndex(
  database: WorkspaceOwnershipDatabase,
  dialect: WorkspaceOwnershipDialect,
  table: string,
): Promise<boolean> {
  const expected = requiredUniqueColumns(table);
  if (!expected) return true;
  if (dialect === 'sqlite') {
    const indexes = rows(
      await database.query(`PRAGMA index_list(${quotedIdentifier(table)})`),
    );
    for (const index of indexes) {
      if (Number(index.unique) !== 1 || typeof index.name !== 'string')
        continue;
      const columns = rows(
        await database.query(
          `PRAGMA index_info(${quotedIdentifier(index.name)})`,
        ),
      )
        .sort((left, right) => Number(left.seqno) - Number(right.seqno))
        .map((column) => String(column.name ?? ''));
      if (columns.join(',') === expected.join(',')) return true;
    }
    return false;
  }
  const indexes = rows(
    await database.query(
      `SELECT pg_get_indexdef(i.indexrelid) AS "definition"
         FROM pg_index i
        WHERE i.indrelid = to_regclass(?) AND i.indisunique`,
      [table],
    ),
  );
  const expectedColumns = expected.join(',');
  return indexes.some((index) => {
    const definition = String(index.definition ?? '')
      .toLowerCase()
      .replaceAll('"', '')
      .replaceAll(/\s+/gu, '');
    return definition.includes(`(${expectedColumns})`);
  });
}

function isBlank(value: unknown): boolean {
  return value === null || value === undefined || value === '';
}

async function mixedLedgerTupleViolations(
  database: WorkspaceOwnershipDatabase,
  table: string,
): Promise<number> {
  const result = await database.query(
    `SELECT tenant_id AS "tenantId", owner_user_id AS "ownerUserId", candidate_profile_id AS "candidateProfileId"
       FROM ${quotedIdentifier(table)}`,
  );
  return rows(result).filter((row) => {
    const tuple = [row.tenantId, row.ownerUserId, row.candidateProfileId];
    return !tuple.every(isBlank) && !tuple.every((value) => !isBlank(value));
  }).length;
}

/**
 * Read-only receipt for the final native schema migration. This does not
 * silently repair constraints: the post-backfill migration must be reviewed
 * separately and this check proves it finished for every owned table.
 */
export async function inspectWorkspaceOwnershipEnforcement(
  database: WorkspaceOwnershipDatabase,
  dialect: WorkspaceOwnershipDialect,
  tables: readonly string[] = workspaceOwnershipTables,
): Promise<WorkspaceOwnershipEnforcementStatus[]> {
  assertWorkspaceOwnershipTableMappings();
  const statuses: WorkspaceOwnershipEnforcementStatus[] = [];
  for (const table of tables) {
    if (!(await tableExists(database, dialect, table))) {
      statuses.push({
        invalidOwnershipTuples: 0,
        missingColumns: [...ownershipColumns(table)],
        missingUniqueIndexes: requiredUniqueColumns(table) ? [table] : [],
        nullableColumns: [],
        table,
        tablePresent: false,
      });
      continue;
    }
    if (dialect === 'sqlite') {
      const result = await database.query(
        `PRAGMA table_info(${quotedIdentifier(table)})`,
      );
      const metadata = new Map(
        rows(result).map((row) => [
          String(row.name ?? ''),
          Number(row.notnull),
        ]),
      );
      const missingColumns = ownershipColumns(table).filter(
        (column) => !metadata.has(column),
      );
      statuses.push({
        invalidOwnershipTuples: workspaceOwnershipMixedLedgerTables.has(table)
          ? await mixedLedgerTupleViolations(database, table)
          : 0,
        missingColumns,
        missingUniqueIndexes:
          missingColumns.length === 0 &&
          !(await hasRequiredUniqueIndex(database, dialect, table))
            ? [table]
            : [],
        nullableColumns: workspaceOwnershipMixedLedgerTables.has(table)
          ? []
          : ownershipColumns(table).filter(
              (column) => metadata.get(column) !== 1,
            ),
        table,
        tablePresent: true,
      });
      continue;
    }
    const result = await database.query(
      `SELECT column_name AS "columnName", is_nullable AS "isNullable"
       FROM information_schema.columns
       WHERE table_schema = current_schema() AND table_name = ?`,
      [table],
    );
    const metadata = new Map(
      rows(result).map((row) => [
        String(row.columnName ?? ''),
        String(row.isNullable ?? ''),
      ]),
    );
    const missingColumns = ownershipColumns(table).filter(
      (column) => !metadata.has(column),
    );
    statuses.push({
      invalidOwnershipTuples: workspaceOwnershipMixedLedgerTables.has(table)
        ? await mixedLedgerTupleViolations(database, table)
        : 0,
      missingColumns,
      missingUniqueIndexes:
        missingColumns.length === 0 &&
        !(await hasRequiredUniqueIndex(database, dialect, table))
          ? [table]
          : [],
      nullableColumns: workspaceOwnershipMixedLedgerTables.has(table)
        ? []
        : ownershipColumns(table).filter(
            (column) => metadata.get(column) !== 'NO',
          ),
      table,
      tablePresent: true,
    });
  }
  return statuses;
}

export function workspaceOwnershipSchemaPrepared(
  statuses: readonly WorkspaceOwnershipSchemaTableStatus[],
): boolean {
  return statuses.every(
    (status) =>
      status.tablePresent &&
      additiveColumns(status.table).every((column) =>
        status.columns.includes(column),
      ),
  );
}

export function workspaceOwnershipSchemaEnforced(
  statuses: readonly WorkspaceOwnershipEnforcementStatus[],
): boolean {
  return statuses.every(
    (status) =>
      status.tablePresent &&
      status.missingColumns.length === 0 &&
      status.nullableColumns.length === 0 &&
      status.missingUniqueIndexes.length === 0 &&
      status.invalidOwnershipTuples === 0,
  );
}
