import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

/** @typedef {{column: string, referencesTable: string, referencesColumn: string, onDelete?: string, onUpdate?: string}} ForeignKey */
/** @typedef {{name: string, columns: string[], unique?: boolean, nullsNotDistinct?: boolean, where?: string, jsonPath?: unknown}} SchemaIndex */
/** @typedef {{tableName: string, columns: Record<string, {type: string, notNull?: boolean, primaryKey?: boolean, unique?: boolean, nullsNotDistinct?: boolean}>, foreignKeys?: ForeignKey[], indexes?: SchemaIndex[], triggers?: unknown[]}} DeploymentSchema */
/** @typedef {Pick<import('@happyvertical/sql').DatabaseInterface, 'query'>} QueryDatabase */

/** Explicit inactive adoption boundary; unknown protocol versions fail closed.
 * @param {Record<string, string | undefined>} env
 */
export function releaseDeploymentProtocolEnabled(env = process.env) {
  const value = env.IOLAUS_DEPLOYMENT_PROTOCOL;
  if (value === undefined) return false;
  if (value === 'smrt-release-v1') return true;
  throw new Error(
    'IOLAUS_DEPLOYMENT_PROTOCOL must be smrt-release-v1 when defined.',
  );
}

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

/** Read-only physical attestation under a nonowner role. Unlike the migration
 * planner's information_schema views, pg_catalog does not hide existing FKs
 * from the runtime principal that correctly lacks REFERENCES/DDL privileges.
 * @param {QueryDatabase} db @param {DeploymentSchema[]} schemas
 */
export async function assertDeploymentCatalogReady(db, schemas) {
  const foreignKeys = await db.query(`SELECT source.relname AS table_name,
    target.relname AS target_table, target_ns.nspname AS target_schema,
    ARRAY(SELECT a.attname::text FROM unnest(c.conkey) WITH ORDINALITY k(num, ord)
      JOIN pg_attribute a ON a.attrelid=c.conrelid AND a.attnum=k.num ORDER BY k.ord) AS columns,
    ARRAY(SELECT a.attname::text FROM unnest(c.confkey) WITH ORDINALITY k(num, ord)
      JOIN pg_attribute a ON a.attrelid=c.confrelid AND a.attnum=k.num ORDER BY k.ord) AS target_columns,
    c.confdeltype AS delete_action, c.confupdtype AS update_action, c.convalidated AS validated,
    c.condeferrable AS deferrable, c.condeferred AS deferred,
    current_schema() AS schema_name
    FROM pg_constraint c JOIN pg_class source ON source.oid=c.conrelid
    JOIN pg_namespace source_ns ON source_ns.oid=source.relnamespace
    JOIN pg_class target ON target.oid=c.confrelid JOIN pg_namespace target_ns ON target_ns.oid=target.relnamespace
    WHERE c.contype='f' AND source_ns.nspname=current_schema()`);
  const indexes =
    await db.query(`SELECT t.relname AS table_name, n.relname AS index_name,
    am.amname AS method, i.indisunique AS unique, i.indnullsnotdistinct AS nulls_not_distinct,
    i.indisvalid AS valid, i.indisready AS ready, i.indislive AS live, i.indisprimary AS primary, i.indimmediate AS immediate,
    i.indnatts AS total_columns, i.indnkeyatts AS key_columns,
    ARRAY(SELECT a.attname::text FROM unnest(i.indkey) WITH ORDINALITY k(num, ord)
      LEFT JOIN pg_attribute a ON a.attrelid=i.indrelid AND a.attnum=k.num
      WHERE k.ord<=i.indnkeyatts ORDER BY k.ord) AS columns,
    ARRAY(SELECT option::integer FROM unnest(i.indoption) option) AS options,
    pg_get_expr(i.indpred,i.indrelid) AS predicate
    FROM pg_index i JOIN pg_class t ON t.oid=i.indrelid JOIN pg_class n ON n.oid=i.indexrelid
    JOIN pg_namespace ns ON ns.oid=t.relnamespace JOIN pg_am am ON am.oid=n.relam
    WHERE ns.nspname=current_schema()`);
  /** @type {Record<string,string>} */
  const actions = {
    'NO ACTION': 'a',
    RESTRICT: 'r',
    CASCADE: 'c',
    'SET NULL': 'n',
    'SET DEFAULT': 'd',
  };
  for (const schema of schemas) {
    if (schema.triggers?.length)
      throw new Error(
        `Unsupported declared startup trigger: ${schema.tableName}.`,
      );
    for (const expected of schema.foreignKeys ?? []) {
      const found = foreignKeys.rows.some(
        (actual) =>
          actual.table_name === schema.tableName &&
          actual.target_table === expected.referencesTable &&
          actual.target_schema === actual.schema_name &&
          JSON.stringify(actual.columns) ===
            JSON.stringify([expected.column]) &&
          JSON.stringify(actual.target_columns) ===
            JSON.stringify([expected.referencesColumn]) &&
          actual.delete_action === actions[expected.onDelete ?? 'NO ACTION'] &&
          actual.update_action === actions[expected.onUpdate ?? 'NO ACTION'] &&
          actual.validated === true &&
          actual.deferrable === false &&
          actual.deferred === false,
      );
      if (!found)
        throw new Error(
          `Deployment foreign key is not ready: ${schema.tableName}.${expected.column}.`,
        );
    }
    const primaryColumns = Object.entries(schema.columns)
      .filter(([, column]) => column.primaryKey)
      .map(([name]) => name);
    if (
      primaryColumns.length &&
      !indexes.rows.some(
        (actual) =>
          actual.table_name === schema.tableName &&
          actual.primary === true &&
          actual.valid === true &&
          actual.ready === true &&
          actual.live === true &&
          JSON.stringify(actual.columns) === JSON.stringify(primaryColumns),
      )
    )
      throw new Error(
        `Deployment primary key is not ready: ${schema.tableName}.`,
      );
    for (const [name, column] of Object.entries(schema.columns)) {
      if (!column.unique) continue;
      // Column UNIQUE clauses may have server-generated constraint names.
      // Match the full-table single-key guarantee, not an index-name guess.
      const found = indexes.rows.some(
        (actual) =>
          actual.table_name === schema.tableName &&
          actual.unique === true &&
          actual.valid === true &&
          actual.ready === true &&
          actual.live === true &&
          actual.immediate === true &&
          actual.method === 'btree' &&
          Number(actual.key_columns) === 1 &&
          actual.predicate === null &&
          JSON.stringify(actual.columns) === JSON.stringify([name]) &&
          (column.nullsNotDistinct === undefined ||
            actual.nulls_not_distinct === column.nullsNotDistinct),
      );
      if (!found)
        throw new Error(
          `Deployment column uniqueness is not ready: ${schema.tableName}.${name}.`,
        );
    }
    for (const expected of schema.indexes ?? []) {
      if (
        expected.jsonPath ||
        expected.columns.some((column) => !/^[a-z_][a-z0-9_]*$/.test(column))
      )
        throw new Error(
          `Unsupported declared startup index: ${expected.name}.`,
        );
      let predicate = null;
      if (expected.where) {
        // One fixed predicate is published by the jobs model closure. Compare
        // its exact PostgreSQL deparse; never erase parentheses or parse SQL.
        if (
          schema.tableName !== '_smrt_jobs' ||
          expected.name !== '_smrt_jobs_ready_idx' ||
          expected.where !==
            "status = 'pending' AND (task_input_requests IS NULL OR task_input_responses IS NOT NULL)"
        )
          throw new Error(
            `Unsupported declared startup predicate: ${expected.name}.`,
          );
        predicate =
          "((status = 'pending'::text) AND ((task_input_requests IS NULL) OR (task_input_responses IS NOT NULL)))";
      }
      const actual = indexes.rows.find(
        (index) =>
          index.table_name === schema.tableName &&
          index.index_name === expected.name,
      );
      if (
        !actual ||
        actual.method !== 'btree' ||
        actual.valid !== true ||
        actual.ready !== true ||
        actual.live !== true ||
        actual.immediate !== true ||
        actual.unique !== Boolean(expected.unique) ||
        actual.nulls_not_distinct !== Boolean(expected.nullsNotDistinct) ||
        Number(actual.key_columns) !== expected.columns.length ||
        Number(actual.total_columns) !== expected.columns.length ||
        JSON.stringify(actual.columns) !== JSON.stringify(expected.columns) ||
        !Array.isArray(actual.options) ||
        actual.options.some((option) => option !== 0) ||
        actual.predicate !== predicate
      )
        throw new Error(
          `Deployment index is not ready: ${schema.tableName}.${expected.name}.`,
        );
    }
  }
}
