import '../src/lib/server/manifest-preload.js';
import '../src/lib/server/smrt.js';
import { resolveDatabase } from '@happyvertical/smrt-core';
import {
  MigrationTracker,
  createMigrationDefinition,
  generateMigrationTimestamp,
} from '@happyvertical/smrt-core/migrations';
import { createHash } from 'node:crypto';
import { chmod, writeFile } from 'node:fs/promises';
import { getDbConfig } from '../src/lib/server/db.js';
import { getPendingSchemaStatements } from './db-common.js';
import { workspaceOwnershipTables } from '../src/lib/server/workspace-ownership-backfill.js';
import { nullEqualConflictIndexTarget } from '../src/lib/server/workspace-ownership-empty-ddl.js';

type QueryResult =
  | { rows?: Array<Record<string, unknown>> }
  | Array<Record<string, unknown>>;

function rows(result: QueryResult): Array<Record<string, unknown>> {
  return Array.isArray(result) ? result : (result.rows ?? []);
}

function quotedIdentifier(value: string): string {
  if (!/^[a-z][a-z0-9_]*$/u.test(value)) {
    throw new Error('Workspace ownership schema identifier is invalid.');
  }
  return `"${value}"`;
}

async function tableExists(
  database: { query: (sql: string, values?: unknown[]) => Promise<QueryResult> },
  dialect: 'postgres' | 'sqlite',
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

function missingOwnershipStatementTarget(
  statement: string,
  missingTables: readonly string[],
): string | null {
  const trimmed = statement.trim();
  const body = trimmed.endsWith(';')
    ? trimmed.slice(0, -1).trim()
    : trimmed;
  const nullEqualTarget = nullEqualConflictIndexTarget(statement);
  if (nullEqualTarget) {
    return missingTables.includes(nullEqualTarget) ? nullEqualTarget : null;
  }
  // A receipt authorizes exactly one native DDL statement, never a batch.
  if (!body || body.includes(';')) return null;
  const table =
    /^CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?"([a-z][a-z0-9_]*)"/iu.exec(
      body,
    )?.[1] ??
    /^CREATE\s+(?:UNIQUE\s+)?INDEX\s+(?:CONCURRENTLY\s+)?(?:IF\s+NOT\s+EXISTS\s+)?[^\s]+\s+ON\s+"([a-z][a-z0-9_]*)"/iu.exec(
      body,
    )?.[1] ??
    /^CREATE\s+(?:OR\s+REPLACE\s+)?TRIGGER\s+[^\s]+[\s\S]*?\sON\s+"([a-z][a-z0-9_]*)"/iu.exec(
      body,
    )?.[1];
  return table && missingTables.includes(table) ? table : null;
}

function ddlTableTarget(statement: string): string | null {
  const trimmed = statement.trim();
  const body = trimmed.endsWith(';')
    ? trimmed.slice(0, -1).trim()
    : trimmed;
  return (
    /^CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?"([a-z][a-z0-9_]*)"/iu.exec(
      body,
    )?.[1] ??
    /^CREATE\s+(?:UNIQUE\s+)?INDEX\s+(?:CONCURRENTLY\s+)?(?:IF\s+NOT\s+EXISTS\s+)?[^\s]+\s+ON\s+"([a-z][a-z0-9_]*)"/iu.exec(
      body,
    )?.[1] ??
    /^CREATE\s+(?:OR\s+REPLACE\s+)?TRIGGER\s+[^\s]+[\s\S]*?\sON\s+"([a-z][a-z0-9_]*)"/iu.exec(
      body,
    )?.[1] ??
    /^(?:ALTER|DROP)\s+TABLE\s+(?:IF\s+EXISTS\s+)?"([a-z][a-z0-9_]*)"/iu.exec(
      body,
    )?.[1] ??
    /^COMMENT\s+ON\s+TABLE\s+"([a-z][a-z0-9_]*)"/iu.exec(body)?.[1] ??
    null
  );
}

function targetsMissingOwnershipTable(
  statement: string,
  missingTables: readonly string[],
): boolean {
  const target = ddlTableTarget(statement);
  if (target) return missingTables.includes(target);
  // A statement that names a missing table but whose affected table cannot be
  // determined is unsafe. A normal FK alter has an explicit existing-table
  // target and is excluded above rather than accidentally admitted by a
  // REFERENCES mention.
  const normalized = statement.toLowerCase();
  return missingTables.some((table) =>
    normalized.includes(quotedIdentifier(table).toLowerCase()),
  );
}

async function writeRejectedDdlReceipt(
  missingTables: readonly string[],
  statements: readonly string[],
): Promise<void> {
  const path = process.env.WORKSPACE_OWNERSHIP_DDL_DIAGNOSTIC_PATH?.trim();
  if (!path) return;
  const receipt = {
    missingTables,
    rejected: statements.map((statement) => ({
      sha256: createHash('sha256').update(statement).digest('hex'),
      statement,
      target: ddlTableTarget(statement),
    })),
  };
  await writeFile(path, `${JSON.stringify(receipt, null, 2)}\n`, {
    encoding: 'utf8',
    mode: 0o600,
  });
  await chmod(path, 0o600);
}

const configuration = getDbConfig();
const database = await resolveDatabase(configuration);
const missingTables = [] as string[];
for (const table of workspaceOwnershipTables) {
  if (!(await tableExists(database, configuration.type, table))) {
    missingTables.push(table);
  }
}

if (missingTables.length === 0) {
  console.log(
    JSON.stringify({
      created: [],
      mode: 'native-empty-workspace-table-phase',
      statementSha256: '',
    }),
  );
} else {
  const pending = await getPendingSchemaStatements(database);
  const ownershipStatements = pending.statements.filter((statement) =>
    targetsMissingOwnershipTable(statement, missingTables),
  );
  const statements = ownershipStatements.filter(
    (statement) => missingOwnershipStatementTarget(statement, missingTables) !== null,
  );
  if (statements.length === 0) {
    throw new Error(
      'The native schema diff has no DDL for a missing workspace ownership table.',
    );
  }

  // This phase may create only tables absent from the verified legacy copy and
  // their native indexes/triggers. Existing tables were intentionally excluded:
  // their ownership fields first receive nullable additions and a reviewed CAS
  // backfill before the ordinary native migration can strengthen constraints.
  const unsafe = ownershipStatements.filter(
    (statement) => missingOwnershipStatementTarget(statement, missingTables) === null,
  );
  if (unsafe.length > 0) {
    await writeRejectedDdlReceipt(missingTables, unsafe);
    throw new Error(
      'The native empty-table phase included a legacy-table alteration; refusing to apply it.',
    );
  }

  const tracker = new MigrationTracker({
    db: database,
    // SMRT's null-equal conflict index has to run atomically. This script is
    // limited above to confirmed-absent tables and their create-only DDL, so
    // the normal online/concurrent path for existing indexes is never relaxed.
    useConcurrentIndexes: false,
  });
  const migration = createMigrationDefinition(
    `${generateMigrationTimestamp()}_workspace_ownership_empty_tables`,
    statements,
    [],
    {
      description: 'Create newly introduced empty workspace ownership tables',
      packageName: '@willgriffin/iolaus-site',
      version: '0.1.0',
    },
  );
  const results = await tracker.applyAll([migration], {
    postgresSafe: false,
    reconcile: true,
  });
  const failed = results.find((result) => !result.success);
  if (failed) {
    throw failed.error instanceof Error
      ? failed.error
      : new Error(String(failed.error ?? 'Native empty-table migration failed.'));
  }

  const remaining = [] as string[];
  for (const table of missingTables) {
    if (!(await tableExists(database, configuration.type, table))) {
      remaining.push(table);
    }
  }
  if (remaining.length > 0) {
    throw new Error('A native empty workspace table was not created.');
  }
  console.log(
    JSON.stringify({
      created: missingTables,
      mode: 'native-empty-workspace-table-phase',
      statementSha256: createHash('sha256')
        .update(statements.join('\n'))
        .digest('hex'),
    }),
  );
}
