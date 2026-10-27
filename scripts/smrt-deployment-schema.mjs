import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

/** @typedef {{tableName: string, columns: Record<string, {type: string, notNull?: boolean}>}} DeploymentSchema */
/** @typedef {Pick<import('@happyvertical/sql').DatabaseInterface, 'query'>} QueryDatabase */

/** Read the immutable build artifact; absence never authorizes schema creation. */
export async function readDeploymentSchemas(sourceRoot = process.cwd()) {
  const candidates = [
    resolve(sourceRoot, 'apps/site/.smrt/manifest.json'),
    resolve(sourceRoot, '.smrt/manifest.json'),
  ];
  /** @type {{packageName?: string, objects?: Record<string, {schema?: DeploymentSchema}>} | undefined} */
  let manifest;
  for (const path of candidates) {
    try {
      manifest = JSON.parse(await readFile(path, 'utf8'));
      break;
    } catch (error) {
      if (
        !(error instanceof Error && 'code' in error && error.code === 'ENOENT')
      )
        throw new Error('Deployment schema artifact is invalid.');
    }
  }
  if (manifest?.packageName !== '@willgriffin/iolaus-site' || !manifest.objects)
    throw new Error('Deployment schema artifact is missing.');
  const schemas = Object.values(manifest.objects)
    .map((object) => object.schema)
    .filter(
      (schema) =>
        schema !== undefined &&
        Boolean(schema.tableName) &&
        Boolean(schema.columns),
    );
  if (schemas.length === 0)
    throw new Error('Deployment schema artifact is empty.');
  const byTable = new Map();
  for (const schema of schemas) {
    if (!schema) throw new Error('Deployment schema artifact is invalid.');
    const previous = byTable.get(schema.tableName);
    byTable.set(schema.tableName, {
      ...schema,
      columns: { ...previous?.columns, ...schema.columns },
    });
  }
  return [...byTable.values()];
}

/** Verify privilege by catalog reads, without attempted DDL or rollback tricks. */
/** @param {QueryDatabase} db */
export async function assertRuntimeDatabaseRole(db) {
  const result =
    await db.query(`SELECT r.rolsuper, r.rolcreatedb, r.rolcreaterole,
    has_database_privilege(current_user, current_database(), 'CREATE') AS database_create,
    EXISTS (SELECT 1 FROM pg_namespace n WHERE n.nspname !~ '^pg_' AND n.nspname <> 'information_schema'
      AND has_schema_privilege(current_user, n.oid, 'CREATE')) AS schema_create,
    EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = current_schema() AND pg_has_role(current_user, c.relowner, 'USAGE')) AS owns_tables
    FROM pg_roles r WHERE r.rolname = current_user`);
  const role = result.rows?.[0];
  if (!role || Object.values(role).some((value) => value !== false))
    throw new Error(
      'Deployed runtime requires a role denied DDL and table ownership.',
    );
}

/** All queries are read-only. Queue recovery may write after this gate returns. */
/** @param {QueryDatabase} db @param {DeploymentSchema[]} schemas */
export async function assertDeploymentSchemaReady(db, schemas) {
  const result =
    await db.query(`SELECT table_name, column_name, data_type, udt_name, is_nullable
    FROM information_schema.columns WHERE table_schema = current_schema()`);
  const columns = new Map(
    result.rows.map((row) => [`${row.table_name}.${row.column_name}`, row]),
  );
  for (const schema of schemas) {
    for (const [name, definition] of Object.entries(schema.columns)) {
      const column = columns.get(`${schema.tableName}.${name}`);
      if (
        !column ||
        (definition.notNull && column.is_nullable !== 'NO') ||
        !postgresTypeMatches(definition.type, column.udt_name)
      )
        throw new Error(
          `Deployment schema is not ready: ${schema.tableName}.${name}. Run the dedicated migration.`,
        );
    }
  }
  for (const table of [
    '_smrt_migrations',
    '_smrt_agent_schedules',
    '_smrt_jobs',
    '_smrt_job_events',
  ]) {
    const found = await db.query('SELECT to_regclass(?) AS relation', [table]);
    if (!found.rows?.[0]?.relation)
      throw new Error(
        `Deployment schema is not ready: ${table}. Run the dedicated migration.`,
      );
  }
}

/** Public static/runtime schema comparison, independent of current database DDL. */
/** @param {Record<string, DeploymentSchema>} runtimeSchemas @param {DeploymentSchema[]} staticSchemas */
export function assertRuntimeStaticAgreement(runtimeSchemas, staticSchemas) {
  const byTable = new Map(
    staticSchemas.map((schema) => [schema.tableName, schema]),
  );
  /** @param {string} type */
  const normalize = (type) =>
    String(type)
      .toUpperCase()
      .replace(/\s+/g, ' ')
      .replace(/^CHARACTER VARYING$/, 'TEXT');
  if (Object.keys(runtimeSchemas).length === 0)
    throw new Error('Runtime schema registry is empty.');
  for (const runtime of Object.values(runtimeSchemas)) {
    const declared = byTable.get(runtime.tableName);
    if (!declared)
      throw new Error(`Runtime/static schema mismatch: ${runtime.tableName}.`);
    const actualNames = Object.keys(runtime.columns).sort();
    const expectedNames = Object.keys(declared.columns).sort();
    if (JSON.stringify(actualNames) !== JSON.stringify(expectedNames))
      throw new Error(
        `Runtime/static schema columns disagree: ${runtime.tableName}.`,
      );
    for (const name of actualNames) {
      const actual = runtime.columns[name];
      const expected = declared.columns[name];
      if (
        normalize(actual.type) !== normalize(expected.type) ||
        Boolean(actual.notNull) !== Boolean(expected.notNull)
      )
        throw new Error(
          `Runtime/static schema definition disagrees: ${runtime.tableName}.${name}.`,
        );
    }
  }
}

/** @param {string} expected @param {unknown} actual */
function postgresTypeMatches(expected, actual) {
  /** @type {Record<string, unknown[]>} */
  const compatible = {
    UUID: ['uuid'],
    TEXT: ['text', 'varchar'],
    JSON: ['json', 'jsonb'],
    TIMESTAMP: ['timestamp', 'timestamptz'],
    INTEGER: ['int4', 'int8'],
    BOOLEAN: ['bool'],
    REAL: ['float4', 'float8', 'numeric'],
  };
  return compatible[String(expected).toUpperCase()]?.includes(actual) === true;
}
