import { createHash, randomBytes } from 'node:crypto';
import {
  existsSync,
  linkSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { basename, dirname, join } from 'node:path';

import { getDatabase } from '@happyvertical/sql';
import {
  MAX_BUNDLE_BYTES,
  readSensitiveBundle,
} from './smrt-portability-assets.mjs';
import { assertExternalArtifactPath } from './smrt-runtime-identity.mjs';
import {
  finalizeReconciliationReport,
  reconcileMigrationRows,
  recordStableIdCollision,
} from './willgriffin-reconciliation.mjs';

export const MIGRATION_BUNDLE_KIND =
  'iolaus/willgriffin.dev-logical-migration';
export const MIGRATION_BUNDLE_VERSION = 1;
export const PREDECESSOR_CONTRACT_VERSION = 1;
export const TARGET_SMRT_VERSION = '0.45.0';
export const DEFAULT_MIGRATION_BATCH_SIZE = 100;
export const SUPPORTED_SOURCE_SCHEMA_FINGERPRINT =
  'd91fb2395dd94a7ccc56e784677fca9d40cb33695bf73ff7bb78f93c3a1a520f';
export const SUPPORTED_TARGET_SCHEMA_FINGERPRINT =
  '7fa0f8411af7c33fc3d45aaddd91780f93bad3ef250938ed53549d0c718605ac';

const SAFE_IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;
const HEX_SHA256 = /^[a-f0-9]{64}$/;
const SOURCE_APPLICATION = 'willgriffin.dev';
const TARGET_APPLICATION = 'iolaus';

const TARGET_MANIFEST_PACKAGES = [
  '@happyvertical/smrt-agents',
  '@happyvertical/smrt-users',
  '@happyvertical/smrt-profiles',
  '@happyvertical/smrt-places',
  '@happyvertical/smrt-tags',
  '@happyvertical/smrt-facts',
  '@happyvertical/smrt-jobs',
];

const INCLUDED_INTERNAL_TABLES = new Set([
  '_smrt_agent_schedules',
  '_smrt_job_events',
  '_smrt_jobs',
]);

/** Security/transient state is deliberately absent from every bundle. */
export const EXCLUDED_SOURCE_TABLES = Object.freeze([
  '_smrt_ai_usage',
  '_smrt_changes',
  '_smrt_changes_pending',
  '_smrt_contexts',
  '_smrt_dispatch',
  '_smrt_dispatch_subscriptions',
  '_smrt_embeddings',
  '_smrt_forge_deliveries',
  '_smrt_forge_projection_checkpoints',
  '_smrt_migrations',
  '_smrt_schema_migrations',
  '_smrt_workers',
  'api_keys',
  'cli_auth_requests',
  'data_repair_audit',
  'data_repair_runs',
  'local_backup_restore_evidence',
  'local_source_crawl_restore_evidence',
  'magic_link_tokens',
  'oidc_profile_email_reservations',
  'sessions',
  'smrt_classes',
  'smrt_objects',
  'users_cli_auth_approve_limits',
  'users_cli_auth_requests',
  'users_magic_link_tokens',
]);

/** Iolaus-only operational state is never populated by predecessor import. */
export const TARGET_ONLY_TABLES = Object.freeze([
  'agent_configs',
  'agents',
  'data_surface_idempotency',
  'data_surface_preview_tokens',
  'tenant_agents',
]);

export const TRANSIENT_TARGET_TABLES = Object.freeze([
  'data_surface_idempotency',
  'data_surface_preview_tokens',
]);

/** Exact framework bootstrap rows created by the pinned target migration. */
export const FRESH_TARGET_BASELINE_COUNTS = Object.freeze({
  candidate_profiles: 1,
  opportunity_intelligence_controls: 1,
  permissions: 580,
  place_types: 5,
  profile_relationship_types: 5,
  profile_types: 3,
  resume_profiles: 1,
  resume_tailoring_configs: 1,
  role_permissions: 1448,
  roles: 4,
  tags: 8,
});

export const REQUIRED_PREDECESSOR_MIGRATIONS = Object.freeze([
  '20260525_smrt_native_employment_backfill',
  '20260525_resume_admin_backfill',
  '20260526_resume_source_model_backfill',
]);

const TARGET_ONLY_COLUMNS = Object.freeze({
  candidate_answers: [
    'provenance',
    'saved_for_reuse_at',
    'revoked_for_reuse_at',
  ],
  candidate_profiles: [
    'facts_json',
    'preferences_json',
    'demographics_json',
    'resume_asset_id',
    'resume_source',
    'onboarding_completed_at',
    'demographics_consent_at',
  ],
  opportunities: ['missed_crawls', 'last_missed_at', 'archive_reason'],
  source_crawls: ['job_attempt', 'request_key'],
  sources: ['source_role', 'parent_source_id', 'provider'],
});

const SOURCE_COLUMN_TYPE_OVERRIDES = Object.freeze({
  'sources.id': 'UUID',
});

// Source schedules predate the released AgentSchedule object and remain owned
// by this application's raw-SQL scheduler. Its stable `source-crawl:<uuid>` id
// is text, so the package manifest's UUID/base-object shape is not applicable.
const APPLICATION_AGENT_SCHEDULE_TABLE = normalizedTable({
  name: '_smrt_agent_schedules',
  columns: [
    { name: 'id', type: 'TEXT', notNull: true, primaryKey: true },
    { name: 'tenant_id', type: 'TEXT', notNull: false },
    { name: 'agent_type', type: 'TEXT', notNull: true },
    { name: 'agent_id', type: 'TEXT', notNull: false },
    { name: 'cron', type: 'TEXT', notNull: true },
    { name: 'method', type: 'TEXT', notNull: true },
    { name: 'method_args', type: 'TEXT', notNull: false },
    { name: 'agent_config', type: 'TEXT', notNull: false },
    { name: 'timeout', type: 'INTEGER', notNull: false },
    { name: 'enabled', type: 'BOOLEAN', notNull: true },
    { name: 'status', type: 'TEXT', notNull: true },
    { name: 'next_run', type: 'TIMESTAMP', notNull: false },
    { name: 'last_run', type: 'TIMESTAMP', notNull: false },
    { name: 'last_status', type: 'TEXT', notNull: false },
    { name: 'last_error', type: 'TEXT', notNull: false },
    { name: 'running_count', type: 'INTEGER', notNull: true },
    { name: 'max_concurrent', type: 'INTEGER', notNull: true },
    { name: 'run_count', type: 'INTEGER', notNull: true },
    { name: 'success_count', type: 'INTEGER', notNull: true },
    { name: 'failure_count', type: 'INTEGER', notNull: true },
    { name: 'created_at', type: 'TIMESTAMP', notNull: true },
    { name: 'updated_at', type: 'TIMESTAMP', notNull: true },
  ],
});

const IMPORT_STAGES = [
  new Set([
    'profile_types',
    'tenants',
    'permissions',
    'roles',
    'users',
    'profiles',
    'profile_metafields',
    'profile_relationship_types',
    'oidc_identities',
    'nostr_identities',
    'memberships',
    'membership_overrides',
    'groups',
    'group_members',
    'group_roles',
    'role_permissions',
    'tenant_permission_overrides',
    'tenant_integrations',
    'profile_assets',
    'profile_metadata',
    'profile_relationships',
    'profile_relationship_terms',
    'access_requests',
    'audit_logs',
  ]),
  new Set([
    'candidate_profiles',
    'candidate_profile_links',
    'candidate_answers',
    'resume_profiles',
    'resume_assets',
    'resume_tailoring_configs',
    'resume_variants',
    'resume_positions',
    'resume_achievements',
    'resume_education',
    'resume_skills',
    'resume_skill_categories',
    'resume_skill_groups',
    'resume_links',
    'resume_other_roles',
  ]),
  new Set([
    'place_types',
    'places',
    'place_assets',
    'tags',
    'tag_aliases',
    'companies',
    'employment_roles',
    'people',
    'experiences',
    'duties',
    'education',
    'achievements',
    'projects',
    'skill_categories',
    'skill_groups',
    'experience_companies',
    'experience_roles',
    'skill_category_members',
    'skill_group_members',
    'achievement_attachments',
    'company_attachments',
    'project_attachments',
    'achievement_tags',
    'company_tags',
    'duty_tags',
    'education_tags',
    'employment_role_tags',
    'experience_tags',
    'project_tags',
  ]),
  new Set(['sources', 'source_crawls', 'source_crawl_items', 'source_tags']),
  new Set([
    'opportunities',
    'opportunity_companies',
    'opportunity_places',
    'opportunity_roles',
    'opportunity_tags',
  ]),
  new Set([
    'company_research',
    'opportunity_intelligence_controls',
    'opportunity_intelligence_requests',
    'opportunity_intelligence_results',
    'evaluation_scores',
    'decisions',
    'decision_tags',
    'facts',
    'fact_contents',
    'fact_evidences',
    'fact_sources',
    'fact_subjects',
    'fact_tags',
    'fact_intakes',
    'fact_candidates',
    'preference_rules',
  ]),
  new Set(['attachments', 'applications', 'application_material_comments']),
  new Set([
    'tasks',
    'agent_runs',
    '_smrt_agent_schedules',
    '_smrt_jobs',
    '_smrt_job_events',
  ]),
];

function quoteIdentifier(value) {
  if (!SAFE_IDENTIFIER.test(value)) {
    throw new Error('Migration schema contains an unsafe SQL identifier.');
  }
  return `"${value}"`;
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function jsonSafe(value) {
  if (value === null || value === undefined) return value ?? null;
  if (typeof value === 'bigint') return value.toString();
  if (value instanceof Date) return value.toISOString();
  if (Buffer.isBuffer(value)) return value.toString('base64');
  if (Array.isArray(value)) return value.map(jsonSafe);
  if (typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, jsonSafe(value[key])]),
    );
  }
  return value;
}

/** Stable JSON for fingerprints; object key and table discovery order do not matter. */
export function canonicalJson(value) {
  return JSON.stringify(jsonSafe(value));
}

export function canonicalRowChecksum(row) {
  return sha256(canonicalJson(row));
}

export function parseMigrationBundle(value) {
  try {
    return JSON.parse(value);
  } catch {
    throw new Error('Migration bundle is not valid JSON.');
  }
}

export async function withSanitizedDatabaseFailure(message, operation) {
  try {
    return await operation();
  } catch {
    throw new Error(message);
  }
}

function normalizedColumn(column) {
  return {
    name: column.name,
    type: String(column.type || '').toUpperCase(),
    notNull: column.notNull === true,
    primaryKey: column.primaryKey === true,
    referencesTable: column.referencesTable || null,
  };
}

function normalizedTable(table) {
  return {
    name: table.name,
    columns: table.columns
      .map(normalizedColumn)
      .sort((left, right) => left.name.localeCompare(right.name)),
  };
}

export function contractFingerprint(tables) {
  return sha256(
    canonicalJson(
      tables
        .map(normalizedTable)
        .sort((left, right) => left.name.localeCompare(right.name)),
    ),
  );
}

function addManifestTables(manifest, tables, options = {}) {
  if (
    options.requirePackageVersion &&
    manifest.packageVersion !== options.requirePackageVersion
  ) {
    throw new Error('Pinned target dependency version does not match the migration contract.');
  }
  for (const definition of Object.values(manifest.objects || {})) {
    const schema = definition?.schema;
    if (definition?.className?.endsWith('Collection') || !schema?.tableName)
      continue;
    if (
      schema.tableName.startsWith('_smrt_') &&
      !INCLUDED_INTERNAL_TABLES.has(schema.tableName)
    )
      continue;
    const columns = Object.entries(schema.columns || {}).map(
      ([name, column]) => ({
        name,
        type: column.type,
        notNull: column.notNull === true,
        primaryKey: column.primaryKey === true,
        referencesTable: column.foreignKey?.table || null,
      }),
    );
    if (columns.length === 0) continue;
    const next = normalizedTable({ name: schema.tableName, columns });
    const previous = tables.get(next.name);
    if (
      previous &&
      canonicalJson(previous.columns) !== canonicalJson(next.columns)
    ) {
      throw new Error(`Conflicting generated schema for ${next.name}.`);
    }
    tables.set(next.name, next);
  }
}

/** Load only released, installed SMRT manifests plus this build's local manifest. */
export function loadTargetContract(sourceRoot) {
  const localManifestPath = join(sourceRoot, '.smrt', 'manifest.json');
  if (!existsSync(localManifestPath)) {
    throw new Error('Build Iolaus before preparing or importing migration data.');
  }
  const appRequire = createRequire(join(sourceRoot, 'apps', 'site', 'package.json'));
  const tables = new Map();
  for (const packageName of TARGET_MANIFEST_PACKAGES) {
    const manifest = JSON.parse(
      readFileSync(appRequire.resolve(`${packageName}/manifest.json`), 'utf8'),
    );
    addManifestTables(manifest, tables, {
      requirePackageVersion: TARGET_SMRT_VERSION,
    });
  }
  addManifestTables(
    JSON.parse(readFileSync(localManifestPath, 'utf8')),
    tables,
  );
  tables.set(
    APPLICATION_AGENT_SCHEDULE_TABLE.name,
    APPLICATION_AGENT_SCHEDULE_TABLE,
  );
  return [...tables.values()].sort((left, right) =>
    left.name.localeCompare(right.name),
  );
}

/** Derive the only supported predecessor shape from the pinned target adapter. */
export function derivePredecessorContract(targetContract) {
  const excluded = new Set([...EXCLUDED_SOURCE_TABLES, ...TARGET_ONLY_TABLES]);
  return targetContract
    .filter((table) => !excluded.has(table.name))
    .map((table) => {
      const targetOnlyColumns = new Set(TARGET_ONLY_COLUMNS[table.name] || []);
      return normalizedTable({
        name: table.name,
        columns: table.columns
          .filter((column) => !targetOnlyColumns.has(column.name))
          .map((column) => ({
            ...column,
            type:
              SOURCE_COLUMN_TYPE_OVERRIDES[`${table.name}.${column.name}`] ||
              column.type,
          })),
      });
    })
    .sort((left, right) => left.name.localeCompare(right.name));
}

export function loadSupportedMigrationContracts(sourceRoot) {
  const targetContract = loadTargetContract(sourceRoot);
  const sourceContract = derivePredecessorContract(targetContract);
  const migratedNames = new Set(sourceContract.map((table) => table.name));
  const migratedTarget = targetContract.filter((table) =>
    migratedNames.has(table.name),
  );
  if (
    contractFingerprint(sourceContract) !==
      SUPPORTED_SOURCE_SCHEMA_FINGERPRINT ||
    contractFingerprint(migratedTarget) !==
      SUPPORTED_TARGET_SCHEMA_FINGERPRINT
  ) {
    throw new Error(
      'Generated schema changed after the predecessor migration adapter was approved.',
    );
  }
  return { sourceContract, targetContract };
}

export function planMigrationTables(sourceContract) {
  const byName = new Map(sourceContract.map((table) => [table.name, table]));
  const planned = [];
  for (const stage of IMPORT_STAGES) {
    const remaining = [...stage].filter((name) => byName.has(name));
    while (remaining.length > 0) {
      const plannedNames = new Set(planned.map((table) => table.name));
      const ready = remaining
        .filter((name) =>
          byName
            .get(name)
            .columns.filter((column) => column.referencesTable)
            .every(
              (column) =>
                column.referencesTable === name ||
                !byName.has(column.referencesTable) ||
                plannedNames.has(column.referencesTable) ||
                !remaining.includes(column.referencesTable),
            ),
        )
        .sort();
      const next = ready[0] || remaining.sort()[0];
      planned.push(byName.get(next));
      remaining.splice(remaining.indexOf(next), 1);
    }
  }
  const unplanned = sourceContract
    .map((table) => table.name)
    .filter((name) => !planned.some((table) => table.name === name));
  if (unplanned.length > 0) {
    throw new Error(
      `Migration contract contains unclassified tables: ${unplanned.join(', ')}.`,
    );
  }
  return planned;
}

function normalizedDatabaseType(value) {
  const type = String(value || '').toLowerCase();
  if (type === 'uuid') return 'UUID';
  if (['text', 'character varying', 'character'].includes(type)) return 'TEXT';
  if (type.startsWith('timestamp')) return 'TIMESTAMP';
  if (['smallint', 'integer', 'bigint'].includes(type)) return 'INTEGER';
  if (['real', 'double precision', 'numeric', 'decimal'].includes(type))
    return 'REAL';
  if (type === 'boolean') return 'BOOLEAN';
  if (['json', 'jsonb'].includes(type)) return 'JSON';
  return type.toUpperCase();
}

export function validateDatabaseSchema(actualColumns, contract, label) {
  const actualByTable = new Map();
  for (const column of actualColumns) {
    const tableName = String(column.tableName || column.table_name || '');
    const columns = actualByTable.get(tableName) || [];
    columns.push({
      name: String(column.columnName || column.column_name || ''),
      type: normalizedDatabaseType(column.dataType || column.data_type),
      notNull:
        String(column.isNullable || column.is_nullable || '').toUpperCase() ===
        'NO',
      isGenerated:
        String(column.isGenerated || column.is_generated || '').toUpperCase() ===
        'ALWAYS',
    });
    actualByTable.set(tableName, columns);
  }
  for (const table of contract) {
    const actual = actualByTable.get(table.name);
    if (!actual) throw new Error(`${label} is missing required table ${table.name}.`);
    const expectedColumns = table.columns.map((column) => column.name).sort();
    // Integrity guards may add PostgreSQL-generated bridge columns. They are
    // derived from logical values, cannot be imported, and are not schema drift.
    const actualNames = actual
      .filter((column) => !column.isGenerated)
      .map((column) => column.name)
      .sort();
    if (canonicalJson(actualNames) !== canonicalJson(expectedColumns)) {
      throw new Error(`${label} columns are incompatible for ${table.name}.`);
    }
    for (const expected of table.columns) {
      const column = actual.find((candidate) => candidate.name === expected.name);
      const expectedType = expected.type === 'REAL' ? 'REAL' : expected.type;
      if (
        !column ||
        column.type !== expectedType ||
        (expected.notNull && !column.notNull)
      ) {
        throw new Error(`${label} column type is incompatible for ${table.name}.`);
      }
    }
  }
}

export function validateSourceTableInventory(actualNames, sourceContract) {
  const allowed = new Set([
    ...sourceContract.map((table) => table.name),
    ...EXCLUDED_SOURCE_TABLES,
  ]);
  if (
    actualNames.some((name) => typeof name !== 'string' || !allowed.has(name)) ||
    sourceContract.some((table) => !actualNames.includes(table.name))
  ) {
    throw new Error('Predecessor table inventory is incompatible.');
  }
}

async function inspectDatabaseSchema(db, contract) {
  const names = contract.map((table) => table.name);
  if (names.length === 0) return [];
  return (
    await db.query(
      `SELECT table_name AS "tableName",
              column_name AS "columnName",
              data_type AS "dataType",
              is_nullable AS "isNullable",
              is_generated AS "isGenerated"
       FROM information_schema.columns
       WHERE table_schema = current_schema()
         AND table_name IN (${names.map(() => '?').join(', ')})
       ORDER BY table_name, ordinal_position`,
      names,
    )
  ).rows;
}

function normalizedSourceRow(_tableName, row) {
  return jsonSafe(row);
}

function requireStableId(table, row) {
  const primaryKeys = table.columns.filter((column) => column.primaryKey);
  if (primaryKeys.length !== 1 || primaryKeys[0].name !== 'id') {
    throw new Error(`Migration table ${table.name} must have one stable id.`);
  }
  const id = row.id;
  if (typeof id !== 'string' || id.trim() === '') {
    throw new Error(`Migration source row in ${table.name} has no stable id.`);
  }
  return id;
}

function parentFirstSourceRows(table, rows) {
  const parentFields = table.columns.filter(
    (column) => column.referencesTable === table.name,
  );
  if (parentFields.length === 0) {
    return rows.sort((left, right) => left.sourceId.localeCompare(right.sourceId));
  }
  const byId = new Map(rows.map((row) => [row.sourceId, row]));
  const dependencies = new Map(rows.map((row) => [row.sourceId, new Set()]));
  const children = new Map(rows.map((row) => [row.sourceId, new Set()]));
  for (const row of rows) {
    for (const field of parentFields) {
      const parentId = row.values[field.name];
      if (parentId == null) continue;
      if (typeof parentId !== 'string' || parentId === '' || !byId.has(parentId)) {
        continue;
      }
      dependencies.get(row.sourceId).add(parentId);
      children.get(parentId).add(row.sourceId);
    }
  }
  const ready = rows
    .filter((row) => dependencies.get(row.sourceId).size === 0)
    .map((row) => row.sourceId)
    .sort();
  const ordered = [];
  while (ready.length > 0) {
    const id = ready.shift();
    ordered.push(byId.get(id));
    for (const childId of children.get(id)) {
      const remaining = dependencies.get(childId);
      remaining.delete(id);
      if (remaining.size === 0) {
        ready.push(childId);
        ready.sort();
      }
    }
  }
  if (ordered.length !== rows.length) {
    // Reconciliation owns invalid relationship quarantine. Preserve every row
    // in deterministic order here so missing parents and cycles are reportable
    // rather than being silently lost or making bundle export impossible.
    const orderedIds = new Set(ordered.map((row) => row.sourceId));
    ordered.push(
      ...rows
        .filter((row) => !orderedIds.has(row.sourceId))
        .sort((left, right) => left.sourceId.localeCompare(right.sourceId)),
    );
  }
  return ordered;
}

export function buildMigrationBundle({
  sourceRows,
  sourceContract,
  targetContract,
  exportedAt = new Date().toISOString(),
}) {
  const plan = planMigrationTables(sourceContract);
  const sourceNames = [...sourceRows.keys()].sort();
  const expectedNames = sourceContract.map((table) => table.name).sort();
  if (canonicalJson(sourceNames) !== canonicalJson(expectedNames)) {
    throw new Error('Source snapshot does not match the migration table contract.');
  }
  const tables = plan.map((table) => {
    const seen = new Set();
    const rows = parentFirstSourceRows(
      table,
      sourceRows
      .get(table.name)
      .map((row) => {
        const values = normalizedSourceRow(table.name, row);
        const sourceId = requireStableId(table, values);
        if (seen.has(sourceId)) {
          throw new Error(`Migration source has duplicate ids in ${table.name}.`);
        }
        seen.add(sourceId);
        return {
          sourceId,
          checksum: canonicalRowChecksum(values),
          values,
        };
      }),
    );
    return {
      name: table.name,
      columns: table.columns.map((column) => column.name),
      rowCount: rows.length,
      checksum: sha256(
        canonicalJson(rows.map((row) => [row.sourceId, row.checksum])),
      ),
      rows,
    };
  });
  const sourceSchemaFingerprint = contractFingerprint(sourceContract);
  const targetSchemaFingerprint = contractFingerprint(
    targetContract.filter((table) =>
      sourceContract.some((source) => source.name === table.name),
    ),
  );
  const sourceFingerprint = sha256(
    canonicalJson({
      contractVersion: PREDECESSOR_CONTRACT_VERSION,
      schema: sourceSchemaFingerprint,
      tables: tables.map((table) => [table.name, table.rowCount, table.checksum]),
    }),
  );
  const runId = `wgd-${sha256(
    canonicalJson({ sourceFingerprint, targetSchemaFingerprint }),
  )}`;
  return {
    kind: MIGRATION_BUNDLE_KIND,
    schemaVersion: MIGRATION_BUNDLE_VERSION,
    sourceApplication: SOURCE_APPLICATION,
    targetApplication: TARGET_APPLICATION,
    predecessorContractVersion: PREDECESSOR_CONTRACT_VERSION,
    exportedAt,
    sourceSchemaFingerprint,
    targetSchemaFingerprint,
    sourceFingerprint,
    runId,
    excludedTables: [...EXCLUDED_SOURCE_TABLES].sort(),
    tables,
  };
}

export function validateMigrationBundle(bundle, sourceContract, targetContract) {
  if (
    !bundle ||
    bundle.kind !== MIGRATION_BUNDLE_KIND ||
    bundle.schemaVersion !== MIGRATION_BUNDLE_VERSION ||
    bundle.sourceApplication !== SOURCE_APPLICATION ||
    bundle.targetApplication !== TARGET_APPLICATION ||
    bundle.predecessorContractVersion !== PREDECESSOR_CONTRACT_VERSION ||
    !Array.isArray(bundle.tables)
  ) {
    throw new Error('Unsupported predecessor migration bundle.');
  }
  if (
    canonicalJson(bundle.excludedTables) !==
    canonicalJson([...EXCLUDED_SOURCE_TABLES].sort())
  ) {
    throw new Error('Migration bundle exclusion inventory is incompatible.');
  }
  const expectedSourceFingerprint = contractFingerprint(sourceContract);
  const migratedTarget = targetContract.filter((table) =>
    sourceContract.some((source) => source.name === table.name),
  );
  const expectedTargetFingerprint = contractFingerprint(migratedTarget);
  if (
    bundle.sourceSchemaFingerprint !== expectedSourceFingerprint ||
    bundle.targetSchemaFingerprint !== expectedTargetFingerprint
  ) {
    throw new Error('Migration bundle schema is incompatible with this Iolaus build.');
  }
  const rows = new Map();
  for (const table of bundle.tables) {
    if (!table || !Array.isArray(table.rows)) {
      throw new Error('Migration bundle contains an invalid table record.');
    }
    if (rows.has(table.name)) {
      throw new Error('Migration bundle contains a duplicate table record.');
    }
    const contract = sourceContract.find((candidate) => candidate.name === table.name);
    if (!contract) throw new Error('Migration bundle contains an unknown table.');
    const expectedColumns = contract.columns.map((column) => column.name);
    if (canonicalJson(table.columns) !== canonicalJson(expectedColumns)) {
      throw new Error(`Migration bundle columns are incompatible for ${table.name}.`);
    }
    const seenIds = new Set();
    for (const row of table.rows) {
      const keys = Object.keys(row.values || {}).sort();
      if (
        typeof row.sourceId !== 'string' ||
        row.sourceId === '' ||
        !HEX_SHA256.test(row.checksum) ||
        canonicalJson(keys) !== canonicalJson([...expectedColumns].sort()) ||
        canonicalRowChecksum(row.values) !== row.checksum ||
        String(row.values.id) !== row.sourceId ||
        seenIds.has(row.sourceId)
      ) {
        throw new Error(`Migration bundle row validation failed for ${table.name}.`);
      }
      seenIds.add(row.sourceId);
    }
    const tableChecksum = sha256(
      canonicalJson(table.rows.map((row) => [row.sourceId, row.checksum])),
    );
    if (table.rowCount !== table.rows.length || table.checksum !== tableChecksum) {
      throw new Error(`Migration bundle checksum failed for ${table.name}.`);
    }
    rows.set(table.name, table.rows.map((row) => row.values));
  }
  const rebuilt = buildMigrationBundle({
    sourceRows: rows,
    sourceContract,
    targetContract,
    exportedAt: bundle.exportedAt,
  });
  for (const key of [
    'sourceFingerprint',
    'sourceSchemaFingerprint',
    'targetSchemaFingerprint',
    'runId',
  ]) {
    if (rebuilt[key] !== bundle[key]) {
      throw new Error('Migration bundle fingerprint validation failed.');
    }
  }
  return bundle;
}

function targetDefaults(tableName, sourceRow) {
  switch (tableName) {
    case 'candidate_answers':
      return {
        provenance: 'legacy_reusable_answer',
        saved_for_reuse_at: null,
        revoked_for_reuse_at: null,
      };
    case 'candidate_profiles':
      return {
        facts_json: '{"facts":{},"unresolvedQuestions":[],"version":1}',
        preferences_json: '{}',
        demographics_json: '{}',
        resume_asset_id: '',
        resume_source: 'not_selected',
        onboarding_completed_at: null,
        demographics_consent_at: null,
      };
    case 'opportunities':
      return { missed_crawls: 0, last_missed_at: null, archive_reason: '' };
    case 'source_crawls':
      return { job_attempt: 0, request_key: `legacy-migration:${sourceRow.id}` };
    case 'sources':
      return { source_role: 'root', parent_source_id: null, provider: 'unknown' };
    default:
      return {};
  }
}

const TERMINAL_JOB_STATUSES = new Set(['cancelled', 'completed', 'failed']);

export function transformMigrationRow(tableName, sourceRow, targetTable) {
  const desired = { ...jsonSafe(sourceRow), ...targetDefaults(tableName, sourceRow) };
  if (tableName === '_smrt_agent_schedules') {
    desired.enabled = false;
    desired.running_count = 0;
    desired.next_run = null;
  }
  if (
    tableName === '_smrt_jobs' &&
    !TERMINAL_JOB_STATUSES.has(String(desired.status || ''))
  ) {
    desired.status = 'cancelled';
    desired.completed_at = desired.completed_at || desired.updated_at;
    desired.worker_id = '';
    desired.worker_heartbeat = null;
  }
  const result = {};
  for (const column of targetTable.columns) {
    if (!(column.name in desired)) {
      throw new Error(`Migration adapter has no target value for ${tableName}.`);
    }
    result[column.name] = desired[column.name];
  }
  return result;
}

function emptyCounts() {
  return { attempted: 0, inserted: 0, updated: 0, skipped: 0 };
}

function addCounts(target, source) {
  for (const key of Object.keys(target)) target[key] += source[key] || 0;
  return target;
}

function reconciliationDigest(tableDigests) {
  return sha256(
    canonicalJson(
      [...tableDigests.entries()].sort(([left], [right]) =>
        left.localeCompare(right),
      ),
    ),
  );
}

function canonicalTargetRowChecksum(row, columns) {
  return canonicalRowChecksum(
    Object.fromEntries(
      columns.map((column) => {
        const value = row[column.name];
        return [column.name, logicalValueFromDatabase(value, column.type)];
      }),
    ),
  );
}

/**
 * Import through a persistence adapter. The production adapter below commits
 * each batch and its checkpoint atomically; tests use the same contract in memory.
 */
export async function importMigrationBundle({
  bundle,
  sourceContract,
  targetContract,
  store,
  dryRun = false,
  batchSize = DEFAULT_MIGRATION_BATCH_SIZE,
  onBatchCommitted,
}) {
  validateMigrationBundle(bundle, sourceContract, targetContract);
  const reconciliationPlan = reconcileMigrationRows({
    bundle,
    sourceContract,
    strictNativeTypes:
      bundle.sourceSchemaFingerprint === SUPPORTED_SOURCE_SCHEMA_FINGERPRINT,
  });
  if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 1_000) {
    throw new Error('Migration batch size must be between 1 and 1000.');
  }
  const sourceNames = new Set(sourceContract.map((table) => table.name));
  const requiredTargetNames = new Set([
    ...sourceNames,
    ...TRANSIENT_TARGET_TABLES,
  ]);
  await store.assertCompatible(
    targetContract.filter((table) => requiredTargetNames.has(table.name)),
  );
  await store.assertTransientTablesEmpty(TRANSIENT_TARGET_TABLES);
  if (!dryRun) await store.ensureLedger();
  const existingRun = dryRun ? null : await store.getRun(bundle.runId);
  if (
    existingRun &&
    (existingRun.sourceFingerprint !== bundle.sourceFingerprint ||
      existingRun.sourceSchemaFingerprint !== bundle.sourceSchemaFingerprint ||
      existingRun.targetSchemaFingerprint !== bundle.targetSchemaFingerprint)
  ) {
    throw new Error('Migration run identity conflicts with the stored ledger.');
  }
  const hasCommittedRows = existingRun
    ? await store.hasCommittedRows(bundle.runId)
    : false;
  if (!hasCommittedRows) await store.assertFreshTarget([...sourceNames]);
  if (!dryRun && !existingRun) await store.createRun(bundle);

  const priorReconciliation = dryRun
    ? null
    : await store.getReconciliationReport?.(bundle.runId);
  if (
    priorReconciliation &&
    priorReconciliation.sourceFingerprint !== bundle.sourceFingerprint
  ) {
    throw new Error('Stored migration reconciliation is incompatible.');
  }
  if (priorReconciliation?.collisions) {
    reconciliationPlan.report.collisions = structuredClone(
      priorReconciliation.collisions,
    );
  }
  if (!dryRun) {
    for (const collision of (await store.getUpdatedRows?.(bundle.runId)) || []) {
      recordStableIdCollision(reconciliationPlan.report, {
        runId: bundle.runId,
        table: collision.table,
        sourceId: collision.sourceId,
      });
    }
  }

  const targetByName = new Map(targetContract.map((table) => [table.name, table]));
  const totals = emptyCounts();
  const tableDigests = new Map();
  const tableReports = [];
  for (const table of bundle.tables) {
    const targetTable = targetByName.get(table.name);
    if (!targetTable) throw new Error('Migration target schema is incomplete.');
    const acceptedTable = reconciliationPlan.acceptedTables.find(
      (candidate) => candidate.name === table.name,
    );
    const desiredRows = (acceptedTable?.rows || []).map((row) => ({
      ...row,
      targetValues: transformMigrationRow(table.name, row.values, targetTable),
    }));
    tableDigests.set(
      table.name,
      sha256(
        canonicalJson(
          desiredRows.map((row) => [
            row.sourceId,
            canonicalTargetRowChecksum(row.targetValues, targetTable.columns),
          ]),
        ),
      ),
    );
    const checkpoint = dryRun
      ? null
      : await store.getCheckpoint(bundle.runId, table.name);
    const report = emptyCounts();
    const checkpointIndex = checkpoint?.cursor
      ? desiredRows.findIndex((row) => row.sourceId === checkpoint.cursor)
      : -1;
    if (checkpoint?.cursor && checkpointIndex < 0) {
      throw new Error(`Migration checkpoint is incompatible for ${table.name}.`);
    }
    const remaining = checkpoint?.complete
      ? []
      : desiredRows.slice(checkpointIndex + 1);
    for (let index = 0; index < remaining.length; index += batchSize) {
      const batch = remaining.slice(index, index + batchSize);
      const operations = [];
      const batchCounts = emptyCounts();
      for (const row of batch) {
        const actual = await store.getTargetRow(
          targetTable,
          row.sourceId,
        );
        const targetChecksum = canonicalTargetRowChecksum(
          row.targetValues,
          targetTable.columns,
        );
        const actualChecksum = actual
          ? canonicalTargetRowChecksum(actual, targetTable.columns)
          : null;
        const action = !actual
          ? 'insert'
          : actualChecksum === targetChecksum
            ? 'skip'
            : 'update';
        if (action === 'update') {
          recordStableIdCollision(reconciliationPlan.report, {
            runId: bundle.runId,
            table: table.name,
            sourceId: row.sourceId,
          });
        }
        batchCounts.attempted += 1;
        batchCounts[
          action === 'skip' ? 'skipped' : action === 'insert' ? 'inserted' : 'updated'
        ] += 1;
        operations.push({
          action,
          sourceId: row.sourceId,
          sourceChecksum: row.checksum,
          targetChecksum,
          targetValues: row.targetValues,
        });
      }
      addCounts(report, batchCounts);
      if (!dryRun) {
        const prior = checkpoint?.counts || emptyCounts();
        await store.commitBatch({
          runId: bundle.runId,
          table: targetTable,
          operations,
          cursor: batch.at(-1).sourceId,
          counts: addCounts({ ...prior }, report),
          complete: index + batchSize >= remaining.length,
          tableChecksum: tableDigests.get(table.name),
        });
        await onBatchCommitted?.({ table: table.name });
      }
    }
    if (!dryRun && remaining.length === 0 && !checkpoint?.complete) {
      await store.commitBatch({
        runId: bundle.runId,
        table: targetTable,
        operations: [],
        cursor: checkpoint?.cursor || '',
        counts: checkpoint?.counts || emptyCounts(),
        complete: true,
        tableChecksum: tableDigests.get(table.name),
      });
    }
    if (!dryRun) {
      for (const row of desiredRows) {
        const actual = await store.getTargetRow(targetTable, row.sourceId);
        if (
          !actual ||
          canonicalTargetRowChecksum(actual, targetTable.columns) !==
            canonicalTargetRowChecksum(row.targetValues, targetTable.columns)
        ) {
          throw new Error(`Completed migration target drifted in ${table.name}.`);
        }
      }
    }
    addCounts(totals, report);
    const cumulative = addCounts(
      { ...(checkpoint?.counts || emptyCounts()) },
      report,
    );
    tableReports.push({
      name: table.name,
      ...report,
      cumulative,
      targetChecksum: tableDigests.get(table.name),
    });
  }
  if (!dryRun) {
    for (const collision of (await store.getUpdatedRows?.(bundle.runId)) || []) {
      recordStableIdCollision(reconciliationPlan.report, {
        runId: bundle.runId,
        table: collision.table,
        sourceId: collision.sourceId,
      });
    }
  }
  const digest = reconciliationDigest(tableDigests);
  const reconciliationReport = finalizeReconciliationReport(
    reconciliationPlan.report,
    tableReports.map((table) => ({
      name: table.name,
      ...table.cumulative,
      targetChecksum: table.targetChecksum,
    })),
  );
  if (!dryRun) {
    await store.recordReconciliation?.(bundle.runId, reconciliationReport);
    await store.completeRun(bundle.runId, digest);
  }
  await store.assertTransientTablesEmpty(TRANSIENT_TARGET_TABLES);
  return {
    schemaVersion: 1,
    status: dryRun ? 'dry-run' : 'complete',
    runId: bundle.runId,
    sourceFingerprint: bundle.sourceFingerprint,
    reconciliationDigest: digest,
    counts: totals,
    tables: tableReports,
    reconciliation: reconciliationReport,
    secretValuesIncluded: false,
  };
}

async function readSourceSnapshot(db, sourceContract) {
  if (typeof db.transaction !== 'function') {
    throw new Error('Predecessor export requires transactional PostgreSQL support.');
  }
  return await db.transaction(async (tx) => {
    await tx.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const readOnly = await tx.query(
      `SELECT current_setting('transaction_read_only') AS "readOnly"`,
    );
    if (!['on', 'true'].includes(String(readOnly.rows[0]?.readOnly))) {
      throw new Error('Predecessor snapshot transaction is not read-only.');
    }
    const sourceTables = await tx.query(
      `SELECT table_name AS "tableName"
       FROM information_schema.tables
       WHERE table_schema = current_schema() AND table_type = 'BASE TABLE'`,
    );
    validateSourceTableInventory(
      sourceTables.rows.map((row) => row.tableName),
      sourceContract,
    );
    validateDatabaseSchema(
      await inspectDatabaseSchema(tx, sourceContract),
      sourceContract,
      'Predecessor schema',
    );
    const migrations = await tx.query(
      `SELECT version FROM _smrt_migrations
       WHERE version IN (${REQUIRED_PREDECESSOR_MIGRATIONS.map(() => '?').join(', ')})`,
      [...REQUIRED_PREDECESSOR_MIGRATIONS],
    );
    const applied = new Set(migrations.rows.map((row) => String(row.version)));
    if (REQUIRED_PREDECESSOR_MIGRATIONS.some((version) => !applied.has(version))) {
      throw new Error('Predecessor database is missing a required schema migration.');
    }
    const rows = new Map();
    for (const table of planMigrationTables(sourceContract)) {
      rows.set(
        table.name,
        (
          await tx.query(
            `SELECT ${table.columns.map((column) => quoteIdentifier(column.name)).join(', ')}
             FROM ${quoteIdentifier(table.name)}
             ORDER BY ${quoteIdentifier('id')}`,
          )
        ).rows,
      );
    }
    return rows;
  });
}

function databaseTargetFingerprint(value) {
  try {
    const url = new URL(value);
    url.username = '';
    url.password = '';
    url.search = '';
    url.hash = '';
    return sha256(url.toString());
  } catch {
    return sha256(String(value || ''));
  }
}

function assertIsolatedRestoreDatabaseUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error('The isolated predecessor database URL is invalid.');
  }
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/gu, '');
  const databaseName = decodeURIComponent(url.pathname.replace(/^\/+|\/+$/gu, ''));
  if (
    !['postgres:', 'postgresql:'].includes(url.protocol) ||
    url.search ||
    url.hash ||
    !['localhost', '127.0.0.1', '::1'].includes(host) ||
    !databaseName ||
    databaseName === 'postgres' ||
    databaseName.startsWith('template') ||
    !/(?:backup|issue|restore|test|verify)/u.test(databaseName)
  ) {
    throw new Error(
      'Predecessor export requires a local database whose name identifies disposable backup, issue, restore, test, or verify work.',
    );
  }
}

function writePrivateBundle(sourceRoot, outputPath, bundle) {
  const resolved = assertExternalArtifactPath({
    sourceRoot,
    path: outputPath,
    label: 'Migration export destination',
  });
  mkdirSync(dirname(resolved), { recursive: true, mode: 0o700 });
  const serialized = `${JSON.stringify(bundle, null, 2)}\n`;
  if (Buffer.byteLength(serialized) > MAX_BUNDLE_BYTES) {
    throw new Error('Migration bundle exceeds the supported size limit.');
  }
  const temporary = join(
    dirname(resolved),
    `.${basename(resolved)}.${process.pid}.${randomBytes(8).toString('hex')}.tmp`,
  );
  try {
    writeFileSync(temporary, serialized, { flag: 'wx', mode: 0o600 });
    try {
      linkSync(temporary, resolved);
    } catch (error) {
      if (error?.code === 'EEXIST') {
        throw new Error('Migration export destination already exists.');
      }
      throw error;
    }
  } finally {
    rmSync(temporary, { force: true });
  }
  return resolved;
}

export async function exportPredecessorMigration(context) {
  if (!context.path) {
    throw new Error(
      'Usage: pnpm migration:willgriffin:export -- /absolute/path/bundle.json',
    );
  }
  if (context.env.WILLGRIFFIN_MIGRATION_SOURCE_ISOLATED_RESTORE !== 'true') {
    throw new Error(
      'Set WILLGRIFFIN_MIGRATION_SOURCE_ISOLATED_RESTORE=true only for a verified isolated restore.',
    );
  }
  const sourceUrl = context.env.WILLGRIFFIN_MIGRATION_SOURCE_DATABASE_URL;
  if (!sourceUrl) {
    throw new Error('The isolated predecessor database URL is unavailable.');
  }
  assertIsolatedRestoreDatabaseUrl(sourceUrl);
  if (
    context.env.DATABASE_URL &&
    databaseTargetFingerprint(sourceUrl) ===
      databaseTargetFingerprint(context.env.DATABASE_URL)
  ) {
    throw new Error('Source and target database endpoints must be distinct.');
  }
  const { sourceContract, targetContract } = loadSupportedMigrationContracts(
    context.sourceRoot,
  );
  return await withSanitizedDatabaseFailure(
    'Predecessor database export failed.',
    async () => {
      const db = await getDatabase({ type: 'postgres', url: sourceUrl });
      try {
        const sourceRows = await readSourceSnapshot(db, sourceContract);
        const bundle = buildMigrationBundle({
          sourceRows,
          sourceContract,
          targetContract,
        });
        writePrivateBundle(context.sourceRoot, context.path, bundle);
        return {
          runId: bundle.runId,
          sourceFingerprint: bundle.sourceFingerprint,
          tableCount: bundle.tables.length,
          rowCount: bundle.tables.reduce(
            (count, table) => count + table.rowCount,
            0,
          ),
          secretValuesIncluded: false,
        };
      } finally {
        await db.close?.();
      }
    },
  );
}

function logicalValueFromDatabase(value, type) {
  if (value == null) return value;
  if (type === 'INTEGER') return String(value);
  if (type === 'REAL') {
    const number = Number(value);
    return Number.isFinite(number) ? number : value;
  }
  if (type === 'BOOLEAN' && typeof value !== 'boolean') {
    if (['true', 't', '1'].includes(String(value).toLowerCase())) return true;
    if (['false', 'f', '0'].includes(String(value).toLowerCase())) return false;
  }
  if (type === 'JSON' && typeof value === 'string') {
    try {
      return JSON.parse(value);
    } catch {
      return value;
    }
  }
  return value;
}

function rowFromDatabase(row, columns) {
  return Object.fromEntries(
    columns.map((column) => [
      column.name,
      logicalValueFromDatabase(row[column.name], column.type),
    ]),
  );
}

export class PostgresMigrationStore {
  constructor(db) {
    this.db = db;
  }

  async assertCompatible(targetContract) {
    validateDatabaseSchema(
      await inspectDatabaseSchema(this.db, targetContract),
      targetContract,
      'Iolaus target schema',
    );
  }

  async assertTransientTablesEmpty(names) {
    for (const name of names) {
      const result = await this.db.query(
        `SELECT COUNT(*) AS count FROM ${quoteIdentifier(name)}`,
      );
      if (Number(result.rows[0]?.count || 0) !== 0) {
        throw new Error(`Iolaus-only state table ${name} must be empty.`);
      }
    }
  }

  async assertFreshTarget(names) {
    for (const name of names) {
      const result = await this.db.query(
        `SELECT COUNT(*) AS count FROM ${quoteIdentifier(name)}`,
      );
      const expected = FRESH_TARGET_BASELINE_COUNTS[name] || 0;
      if (Number(result.rows[0]?.count || 0) !== expected) {
        throw new Error('Migration requires a freshly initialized target.');
      }
    }
  }

  async ensureLedger() {
    await this.db.query(`
      CREATE TABLE IF NOT EXISTS _iolaus_migration_runs (
        run_id TEXT PRIMARY KEY,
        source_fingerprint TEXT NOT NULL,
        source_schema_fingerprint TEXT NOT NULL,
        target_schema_fingerprint TEXT NOT NULL,
        status TEXT NOT NULL,
        reconciliation_digest TEXT,
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        completed_at TIMESTAMP
      )
    `);
    await this.db.query(`
      CREATE TABLE IF NOT EXISTS _iolaus_migration_checkpoints (
        run_id TEXT NOT NULL REFERENCES _iolaus_migration_runs(run_id),
        table_name TEXT NOT NULL,
        cursor TEXT NOT NULL DEFAULT '',
        attempted INTEGER NOT NULL DEFAULT 0,
        inserted INTEGER NOT NULL DEFAULT 0,
        updated INTEGER NOT NULL DEFAULT 0,
        skipped INTEGER NOT NULL DEFAULT 0,
        complete BOOLEAN NOT NULL DEFAULT FALSE,
        table_checksum TEXT NOT NULL,
        updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (run_id, table_name)
      )
    `);
    await this.db.query(`
      CREATE TABLE IF NOT EXISTS _iolaus_migration_rows (
        run_id TEXT NOT NULL REFERENCES _iolaus_migration_runs(run_id),
        table_name TEXT NOT NULL,
        source_id TEXT NOT NULL,
        source_checksum TEXT NOT NULL,
        target_checksum TEXT NOT NULL,
        action TEXT NOT NULL,
        updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (run_id, table_name, source_id)
      )
    `);
    await this.db.query(`
      CREATE TABLE IF NOT EXISTS _iolaus_migration_quarantine (
        run_id TEXT NOT NULL REFERENCES _iolaus_migration_runs(run_id),
        table_name TEXT NOT NULL,
        record_key_hash TEXT NOT NULL,
        reason_code TEXT NOT NULL,
        field_name TEXT NOT NULL DEFAULT '',
        parent_table TEXT NOT NULL DEFAULT '',
        reference_key_hash TEXT,
        PRIMARY KEY (run_id, table_name, record_key_hash, reason_code,
                     field_name, parent_table)
      )
    `);
    await this.db.query(`
      CREATE TABLE IF NOT EXISTS _iolaus_migration_reconciliation (
        run_id TEXT PRIMARY KEY REFERENCES _iolaus_migration_runs(run_id),
        report_digest TEXT NOT NULL,
        report_json JSONB NOT NULL,
        updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
      )
    `);
  }

  async getRun(runId) {
    const result = await this.db.query(
      `SELECT source_fingerprint, source_schema_fingerprint, target_schema_fingerprint,
              status, reconciliation_digest
       FROM _iolaus_migration_runs WHERE run_id = ?`,
      [runId],
    );
    const row = result.rows[0];
    return row
      ? {
          sourceFingerprint: row.source_fingerprint,
          sourceSchemaFingerprint: row.source_schema_fingerprint,
          targetSchemaFingerprint: row.target_schema_fingerprint,
          status: row.status,
          reconciliationDigest: row.reconciliation_digest,
        }
      : null;
  }

  async hasCommittedRows(runId) {
    const result = await this.db.query(
      `SELECT COUNT(*) AS count FROM _iolaus_migration_rows WHERE run_id = ?`,
      [runId],
    );
    return Number(result.rows[0]?.count || 0) > 0;
  }

  async createRun(bundle) {
    await this.db.query(
      `INSERT INTO _iolaus_migration_runs
       (run_id, source_fingerprint, source_schema_fingerprint,
        target_schema_fingerprint, status)
       VALUES (?, ?, ?, ?, 'running')`,
      [
        bundle.runId,
        bundle.sourceFingerprint,
        bundle.sourceSchemaFingerprint,
        bundle.targetSchemaFingerprint,
      ],
    );
  }

  async getCheckpoint(runId, tableName) {
    const result = await this.db.query(
      `SELECT cursor, attempted, inserted, updated, skipped, complete
       FROM _iolaus_migration_checkpoints
       WHERE run_id = ? AND table_name = ?`,
      [runId, tableName],
    );
    const row = result.rows[0];
    return row
      ? {
          cursor: String(row.cursor || ''),
          counts: {
            attempted: Number(row.attempted || 0),
            inserted: Number(row.inserted || 0),
            updated: Number(row.updated || 0),
            skipped: Number(row.skipped || 0),
          },
          complete: row.complete === true,
        }
      : null;
  }

  async getTargetRow(table, id) {
    const result = await this.db.query(
      `SELECT ${table.columns.map((column) => quoteIdentifier(column.name)).join(', ')}
       FROM ${quoteIdentifier(table.name)} WHERE ${quoteIdentifier('id')} = ?`,
      [id],
    );
    return result.rows[0]
      ? rowFromDatabase(result.rows[0], table.columns)
      : null;
  }

  async getReconciliationReport(runId) {
    const result = await this.db.query(
      `SELECT report_json FROM _iolaus_migration_reconciliation WHERE run_id = ?`,
      [runId],
    );
    const value = result.rows[0]?.report_json;
    if (typeof value === 'string') {
      try {
        return JSON.parse(value);
      } catch {
        throw new Error('Stored migration reconciliation is incompatible.');
      }
    }
    return value || null;
  }

  async getUpdatedRows(runId) {
    const result = await this.db.query(
      `SELECT table_name, source_id
       FROM _iolaus_migration_rows
       WHERE run_id = ? AND action = 'update'
       ORDER BY table_name, source_id`,
      [runId],
    );
    return result.rows.map((row) => ({
      sourceId: String(row.source_id),
      table: String(row.table_name),
    }));
  }

  async recordReconciliation(runId, report) {
    try {
      await this.db.transaction(async (tx) => {
        await tx.query(
          `DELETE FROM _iolaus_migration_quarantine WHERE run_id = ?`,
          [runId],
        );
        for (const entry of report.quarantine) {
          await tx.query(
            `INSERT INTO _iolaus_migration_quarantine
             (run_id, table_name, record_key_hash, reason_code, field_name,
              parent_table, reference_key_hash)
             VALUES (?, ?, ?, ?, ?, ?, ?)`,
            [
              runId,
              entry.table,
              entry.recordKeyHash,
              entry.reasonCode,
              entry.field || '',
              entry.parentTable || '',
              entry.referenceKeyHash,
            ],
          );
        }
        await tx.query(
          `INSERT INTO _iolaus_migration_reconciliation
           (run_id, report_digest, report_json)
           VALUES (?, ?, ?)
           ON CONFLICT (run_id) DO UPDATE SET
             report_digest = EXCLUDED.report_digest,
             report_json = EXCLUDED.report_json,
             updated_at = CURRENT_TIMESTAMP`,
          [runId, report.reportDigest, report],
        );
      });
    } catch {
      throw new Error('Migration reconciliation ledger write failed.');
    }
  }

  async commitBatch({
    runId,
    table,
    operations,
    cursor,
    counts,
    complete,
    tableChecksum,
  }) {
    try {
      await this.db.transaction(async (tx) => {
        for (const operation of operations) {
          if (operation.action !== 'skip') {
            const columns = table.columns.map((column) => column.name);
            const assignments = columns
              .filter((column) => column !== 'id')
              .map(
                (column) =>
                  `${quoteIdentifier(column)} = EXCLUDED.${quoteIdentifier(column)}`,
              );
            await tx.query(
              `INSERT INTO ${quoteIdentifier(table.name)}
               (${columns.map(quoteIdentifier).join(', ')})
               VALUES (${columns.map(() => '?').join(', ')})
               ON CONFLICT (${quoteIdentifier('id')}) DO UPDATE SET
               ${assignments.join(', ')}`,
              columns.map((column) => operation.targetValues[column]),
            );
          }
          await tx.query(
            `INSERT INTO _iolaus_migration_rows
             (run_id, table_name, source_id, source_checksum, target_checksum, action)
             VALUES (?, ?, ?, ?, ?, ?)
             ON CONFLICT (run_id, table_name, source_id) DO UPDATE SET
               source_checksum = EXCLUDED.source_checksum,
               target_checksum = EXCLUDED.target_checksum,
               action = EXCLUDED.action,
               updated_at = CURRENT_TIMESTAMP`,
            [
              runId,
              table.name,
              operation.sourceId,
              operation.sourceChecksum,
              operation.targetChecksum,
              operation.action,
            ],
          );
        }
        await tx.query(
          `INSERT INTO _iolaus_migration_checkpoints
           (run_id, table_name, cursor, attempted, inserted, updated, skipped,
            complete, table_checksum)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT (run_id, table_name) DO UPDATE SET
             cursor = EXCLUDED.cursor,
             attempted = EXCLUDED.attempted,
             inserted = EXCLUDED.inserted,
             updated = EXCLUDED.updated,
             skipped = EXCLUDED.skipped,
             complete = EXCLUDED.complete,
             table_checksum = EXCLUDED.table_checksum,
             updated_at = CURRENT_TIMESTAMP`,
          [
            runId,
            table.name,
            cursor,
            counts.attempted,
            counts.inserted,
            counts.updated,
            counts.skipped,
            complete,
            tableChecksum,
          ],
        );
      });
    } catch {
      throw new Error(`Migration batch write failed for ${table.name}.`);
    }
  }

  async completeRun(runId, digest) {
    await this.db.query(
      `UPDATE _iolaus_migration_runs
       SET status = 'complete', reconciliation_digest = ?,
           completed_at = COALESCE(completed_at, CURRENT_TIMESTAMP),
           updated_at = CURRENT_TIMESTAMP
       WHERE run_id = ?`,
      [digest, runId],
    );
  }
}

export async function importPredecessorMigration(context) {
  if (!context.path) {
    throw new Error(
      'Usage: pnpm migration:willgriffin:import -- /absolute/path/bundle.json [--dry-run]',
    );
  }
  if (context.runtime.providers.database.engine !== 'postgres') {
    throw new Error('Predecessor migration targets PostgreSQL only.');
  }
  const { sourceContract, targetContract } = loadSupportedMigrationContracts(
    context.sourceRoot,
  );
  const bundle = parseMigrationBundle(readSensitiveBundle(context.path));
  return await withSanitizedDatabaseFailure(
    'Predecessor database import failed.',
    async () => {
      const db = await getDatabase({
        type: 'postgres',
        url: context.env.DATABASE_URL,
      });
      try {
        return await importMigrationBundle({
          bundle,
          sourceContract,
          targetContract,
          store: new PostgresMigrationStore(db),
          dryRun: context.dryRun === true,
        });
      } finally {
        await db.close?.();
      }
    },
  );
}
