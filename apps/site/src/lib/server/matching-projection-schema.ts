import { detectEngine } from '@happyvertical/smrt-core';
import type { DatabaseInterface } from '@happyvertical/sql';

type Dialect = 'sqlite' | 'postgres';
type Event = 'INSERT' | 'UPDATE' | 'DELETE';
type Image = 'NEW' | 'OLD';
type Executor = Pick<DatabaseInterface, 'query'>;

const events = ['INSERT', 'UPDATE', 'DELETE'] as const;
const registries = [
  ['opportunities', 'matching_source_versions', 'opportunity_id'],
  ['candidate_profiles', 'matching_profile_versions', 'profile_id'],
  ['sources', 'matching_source_listing_versions', 'source_id'],
] as const;

const schemaRevision = 2;
const schemaVersionColumn = 'schema_revision INTEGER NOT NULL DEFAULT 0';
const workerCursorDdl = `CREATE TABLE IF NOT EXISTS matching_worker_cursor (
  id INTEGER PRIMARY KEY CHECK (id = 1), source_cursor TEXT NOT NULL, profile_cursor TEXT NOT NULL,
  work_revision BIGINT NOT NULL DEFAULT 0, source_event_revision BIGINT NOT NULL DEFAULT 0,
  ${schemaVersionColumn})`;

const schema = [
  ...registries.map(
    ([, table, key]) =>
      `CREATE TABLE IF NOT EXISTS ${table} (
        ${key} TEXT PRIMARY KEY NOT NULL, revision BIGINT NOT NULL)`,
  ),
  `CREATE TABLE IF NOT EXISTS matching_vocabulary_version (
     id INTEGER PRIMARY KEY CHECK (id = 1), revision BIGINT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS matching_source_facts (
     opportunity_id TEXT PRIMARY KEY NOT NULL, source_revision BIGINT NOT NULL,
     source_listing_revision BIGINT NOT NULL, vocabulary_revision BIGINT NOT NULL,
     policy_version TEXT NOT NULL, facts_json TEXT NOT NULL, work_revision BIGINT NOT NULL UNIQUE)`,
  `CREATE TABLE IF NOT EXISTS matching_source_extraction_cursor (
     id INTEGER PRIMARY KEY CHECK (id = 1), work_cursor BIGINT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS matching_source_interpretations (
     opportunity_id TEXT PRIMARY KEY NOT NULL, source_fingerprint TEXT NOT NULL, source_content_version BIGINT NOT NULL,
     contract_version TEXT NOT NULL, input_digest TEXT NOT NULL, state TEXT NOT NULL CHECK (state IN ('running', 'complete', 'retry', 'failed')),
     lease TEXT NOT NULL, next_run_at BIGINT NOT NULL, attempts INTEGER NOT NULL,
     payload_json TEXT NOT NULL, request_id TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS matching_profile_facts (
     profile_id TEXT PRIMARY KEY NOT NULL, tenant_id TEXT NOT NULL, user_id TEXT NOT NULL,
     profile_revision BIGINT NOT NULL, vocabulary_revision BIGINT NOT NULL,
     policy_version TEXT NOT NULL, facts_json TEXT NOT NULL,
     status TEXT NOT NULL CHECK (status IN ('pending', 'ready', 'missing-preferences', 'needs-evidence', 'failed')),
     cursor BIGINT NOT NULL DEFAULT 0, next_run_at BIGINT NOT NULL DEFAULT 0)`,
  `CREATE TABLE IF NOT EXISTS matching_results (
     profile_id TEXT NOT NULL, tenant_id TEXT NOT NULL, user_id TEXT NOT NULL, opportunity_id TEXT NOT NULL,
     profile_revision BIGINT NOT NULL, source_revision BIGINT NOT NULL, source_listing_revision BIGINT NOT NULL,
     vocabulary_revision BIGINT NOT NULL, policy_version TEXT NOT NULL,
     status TEXT NOT NULL CHECK (status IN ('pending', 'qualified', 'conflict', 'insufficient-evidence', 'failed')),
     score INTEGER NOT NULL, reasons_json TEXT NOT NULL, PRIMARY KEY (profile_id, opportunity_id))`,
  'CREATE INDEX IF NOT EXISTS matching_results_discovery ON matching_results (profile_id, profile_revision, vocabulary_revision, policy_version, status, score DESC, opportunity_id)',
  'CREATE INDEX IF NOT EXISTS matching_results_opportunity ON matching_results (opportunity_id)',
  'CREATE INDEX IF NOT EXISTS matching_profile_facts_schedule ON matching_profile_facts (next_run_at, profile_id)',
  'CREATE INDEX IF NOT EXISTS matching_source_versions_revision ON matching_source_versions (revision)',
  'CREATE INDEX IF NOT EXISTS matching_profile_versions_revision ON matching_profile_versions (revision)',
  'CREATE INDEX IF NOT EXISTS matching_opportunity_input_id ON opportunities (CAST(id AS TEXT))',
  'CREATE INDEX IF NOT EXISTS matching_profile_input_id ON candidate_profiles (CAST(id AS TEXT))',
  'CREATE INDEX IF NOT EXISTS matching_profile_input_owner ON candidate_profiles (CAST(owner_user_id AS TEXT), CAST(tenant_id AS TEXT))',
  'CREATE INDEX IF NOT EXISTS matching_profile_input_tenant ON candidate_profiles (CAST(tenant_id AS TEXT))',
];

type Trigger = {
  table: string;
  columns: readonly string[];
  /** Match profiles by live owner and active context, including on reparenting. */
  affects?: (row: Image) => string;
  relevant?: (row: Image) => string;
};

const ownerProfile = (row: Image) =>
  `CAST(p.id AS TEXT) = CAST(${row}.candidate_profile_id AS TEXT)
   AND CAST(p.owner_user_id AS TEXT) = CAST(${row}.owner_user_id AS TEXT)
   AND CAST(p.tenant_id AS TEXT) = CAST(${row}.tenant_id AS TEXT)`;

const triggers: readonly Trigger[] = [
  {
    table: 'opportunities',
    columns: [
      'id',
      'title',
      'description_raw',
      'locations',
      'location_notes',
      'work_mode',
      'source_id',
      'status',
      'expires_at',
      'source_content_json',
      'source_content_version',
      'source_content_fingerprint',
    ],
  },
  {
    table: 'sources',
    columns: ['id', 'public_listing', 'is_active'],
  },
  {
    table: 'candidate_profiles',
    columns: [
      'id',
      'active',
      'tenant_id',
      'owner_user_id',
      'preferences_json',
      'facts_json',
      'target_work_country_json',
    ],
  },
  {
    table: 'resume_skills',
    columns: [
      'id',
      'tenant_id',
      'owner_user_id',
      'candidate_profile_id',
      'label',
    ],
    affects: ownerProfile,
  },
  {
    table: 'resume_positions',
    columns: [
      'id',
      'tenant_id',
      'owner_user_id',
      'candidate_profile_id',
      'role',
      'blurb',
      'start',
      'end_label',
    ],
    affects: ownerProfile,
  },
  {
    table: 'resume_achievements',
    columns: [
      'id',
      'tenant_id',
      'owner_user_id',
      'candidate_profile_id',
      'title',
      'body',
    ],
    affects: ownerProfile,
  },
  {
    table: 'preference_rules',
    columns: [
      'id',
      'tenant_id',
      'owner_user_id',
      'candidate_profile_id',
      'category',
      'active',
      'name',
      'description',
      'is_hard_filter',
      'rule_json',
      'updated_at',
    ],
    affects: ownerProfile,
    relevant: (row) =>
      `${row}.category = 'screening_questions' AND ${row}.active = TRUE`,
  },
  {
    table: 'memberships',
    columns: ['tenant_id', 'user_id', 'status', 'role_id'],
    affects: (row) =>
      `CAST(p.tenant_id AS TEXT) = CAST(${row}.tenant_id AS TEXT)
       AND CAST(p.owner_user_id AS TEXT) = CAST(${row}.user_id AS TEXT)`,
  },
  {
    table: 'users',
    columns: ['id', 'status'],
    affects: (row) => `CAST(p.owner_user_id AS TEXT) = CAST(${row}.id AS TEXT)`,
  },
  {
    table: 'tenants',
    columns: ['id', 'status'],
    affects: (row) => `CAST(p.tenant_id AS TEXT) = CAST(${row}.id AS TEXT)`,
  },
  {
    table: 'skill_terms',
    columns: [
      'skill_slug',
      'label',
      'aliases_json',
      'parent_slug',
      'related_json',
      'status',
    ],
    relevant: (row) => `${row}.status IN ('seed', 'confirmed')`,
  },
];

function revision(dialect: Dialect) {
  return dialect === 'postgres'
    ? "nextval('matching_revision_clock_id_seq')"
    : '(SELECT revision FROM matching_revision_clock WHERE id = 1)';
}

/** Mark one source snapshot stale when its separate shared interpretation publishes. */
export async function advanceMatchingSourceRevision(
  db: Executor,
  dialect: Dialect,
  opportunityId: string,
) {
  if (dialect === 'sqlite') {
    await db.query(
      'UPDATE matching_revision_clock SET revision = revision + 1 WHERE id = 1',
    );
  }
  await db.query(
    `UPDATE matching_source_versions SET revision = ${revision(dialect)} WHERE opportunity_id = ?`,
    [opportunityId],
  );
}

function changed(dialect: Dialect, columns: readonly string[]) {
  const operator = dialect === 'postgres' ? 'IS DISTINCT FROM' : 'IS NOT';
  return columns
    .map((column) => `NEW."${column}" ${operator} OLD."${column}"`)
    .join(' OR ');
}

function cleanup(table: string, condition: string): string[] {
  const registry = registries.find(([raw]) => raw === table);
  if (!registry) return [];
  const [, versions, key] = registry;
  const byOldId = `${key} = CAST(OLD.id AS TEXT) AND (${condition})`;
  const statements = [`DELETE FROM ${versions} WHERE ${byOldId};`];
  if (table === 'candidate_profiles') {
    statements.push(
      `DELETE FROM matching_profile_facts WHERE ${byOldId};`,
      `DELETE FROM matching_results WHERE ${byOldId};`,
    );
  }
  if (table === 'opportunities') {
    statements.push(
      `DELETE FROM matching_source_facts WHERE ${byOldId};`,
      `DELETE FROM matching_source_interpretations WHERE ${byOldId};`,
      `DELETE FROM matching_results WHERE ${byOldId};`,
    );
  }
  return statements;
}

function touch(
  dialect: Dialect,
  table: string,
  key: string,
  entities: string,
): string {
  return `INSERT INTO ${table} (${key}, revision)
    SELECT entity.id, ${revision(dialect)} FROM (${entities}) entity WHERE entity.id IS NOT NULL
    ON CONFLICT (${key}) DO UPDATE SET revision = excluded.revision;`;
}

function triggerBody(trigger: Trigger, event: Event, dialect: Dialect): string {
  const { table, affects, relevant } = trigger;
  const statements: string[] = [];
  const images: Image[] =
    event === 'UPDATE' ? ['NEW', 'OLD'] : [event === 'DELETE' ? 'OLD' : 'NEW'];
  if (dialect === 'sqlite') {
    statements.push(
      'UPDATE matching_revision_clock SET revision = revision + 1 WHERE id = 1;',
    );
  }
  if (table === 'skill_terms') {
    statements.push(
      `UPDATE matching_vocabulary_version SET revision = ${revision(dialect)} WHERE id = 1;`,
    );
  } else if (affects) {
    const profiles = images.map(
      (row) => `SELECT CAST(p.id AS TEXT) AS id FROM candidate_profiles p
        WHERE (${affects(row)}) AND (${relevant?.(row) ?? 'TRUE'})`,
    );
    statements.push(
      touch(
        dialect,
        'matching_profile_versions',
        'profile_id',
        profiles.join(' UNION '),
      ),
    );
  } else {
    const registry = registries.find(([raw]) => raw === table);
    if (!registry) throw new Error(`No matching input registry for ${table}`);
    const [, versions, key] = registry;
    if (event === 'DELETE') {
      statements.push(...cleanup(table, 'TRUE'));
    } else {
      if (event === 'UPDATE') {
        statements.push(...cleanup(table, changed(dialect, ['id'])));
      }
      // Take the version row's write lock before cleaning up the projection.
      // A worker already publishing this revision must commit before cleanup.
      statements.push(
        touch(dialect, versions, key, 'SELECT CAST(NEW.id AS TEXT) AS id'),
      );
      if (event === 'UPDATE' && table === 'candidate_profiles') {
        // Active/context changes can revoke access to derived private evidence.
        const revoked = `NOT COALESCE(NEW.active, FALSE) OR ${changed(dialect, ['tenant_id', 'owner_user_id'])}`;
        statements.push(
          `DELETE FROM matching_profile_facts WHERE profile_id = CAST(OLD.id AS TEXT) AND (${revoked});`,
          `DELETE FROM matching_results WHERE profile_id = CAST(OLD.id AS TEXT) AND (${revoked});`,
        );
      }
    }
  }
  return statements.join('\n');
}

function triggerCondition(trigger: Trigger, event: Event, dialect: Dialect) {
  const criteria: string[] = [];
  if (event === 'UPDATE') criteria.push(changed(dialect, trigger.columns));
  if (trigger.relevant) {
    const images: Image[] =
      event === 'UPDATE'
        ? ['OLD', 'NEW']
        : [event === 'DELETE' ? 'OLD' : 'NEW'];
    criteria.push(images.map(trigger.relevant).join(' OR '));
  }
  return criteria.map((condition) => `(${condition})`).join(' AND ');
}

async function ensureInputTriggers(db: Executor, dialect: Dialect) {
  for (const trigger of triggers) {
    const functionName = `matching_touch_${trigger.table}`;
    if (dialect === 'postgres') {
      const branches = events.map((event) => {
        const condition = triggerCondition(trigger, event, dialect);
        return `IF TG_OP = '${event}' THEN
          ${condition ? `IF ${condition} THEN` : ''}
          ${triggerBody(trigger, event, dialect)}
          ${condition ? 'END IF;' : ''}
          RETURN NULL;
        END IF;`;
      });
      await db.query(`CREATE OR REPLACE FUNCTION ${functionName}() RETURNS TRIGGER
        LANGUAGE plpgsql AS $$ BEGIN ${branches.join('\n')} RETURN NULL; END; $$`);
    }
    for (const event of events) {
      const name = `${functionName}_${event.toLowerCase()}`;
      const updateColumns =
        event === 'UPDATE'
          ? ` OF ${trigger.columns.map((column) => `"${column}"`).join(', ')}`
          : '';
      if (dialect === 'postgres') {
        await db.query(`CREATE OR REPLACE TRIGGER ${name} AFTER ${event}${updateColumns} ON ${trigger.table}
          FOR EACH ROW EXECUTE FUNCTION ${functionName}()`);
      } else {
        const condition = triggerCondition(trigger, event, dialect);
        await db.query(`DROP TRIGGER IF EXISTS ${name}`);
        await db.query(`CREATE TRIGGER ${name} AFTER ${event}${updateColumns} ON ${trigger.table}
          FOR EACH ROW ${condition ? `WHEN ${condition}` : ''}
          BEGIN ${triggerBody(trigger, event, dialect)} END`);
      }
    }
  }
}

async function hasSchemaRevisionColumn(db: Executor, dialect: Dialect) {
  const probe =
    dialect === 'postgres'
      ? `SELECT 1 FROM pg_attribute WHERE attrelid = to_regclass('matching_worker_cursor')
        AND attname = 'schema_revision' AND NOT attisdropped`
      : `SELECT 1 FROM pragma_table_info('matching_worker_cursor') WHERE name = 'schema_revision'`;
  return (await db.query(probe)).rows.length > 0;
}

async function installedSchemaRevision(db: Executor, dialect: Dialect) {
  if (!(await hasSchemaRevisionColumn(db, dialect))) return 0;
  const marker = await db.query(
    'SELECT schema_revision FROM matching_worker_cursor WHERE id = 1',
  );
  return Number(marker.rows[0]?.schema_revision ?? 0);
}

async function hasMatchingInputTriggers(db: Executor, dialect: Dialect) {
  // A later native table migration can rebuild a table. Reinstall missing
  // triggers before serving rather than assuming that the marker is sufficient.
  const triggerNames = triggers.flatMap(({ table }) =>
    events.map((event) => `'matching_touch_${table}_${event.toLowerCase()}'`),
  );
  const probe =
    dialect === 'postgres'
      ? `SELECT tgname FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
        JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = current_schema() AND t.tgenabled IN ('O','A')
        AND tgname IN (${triggerNames.join(',')})`
      : `SELECT name FROM sqlite_master WHERE type = 'trigger' AND name IN (${triggerNames.join(',')})`;
  return (await db.query(probe)).rows.length === triggerNames.length;
}

export async function matchingProjectionSchemaReady(
  db: Pick<DatabaseInterface, 'query' | 'url'>,
  dialect: Dialect = detectEngine(db.url) === 'sqlite' ? 'sqlite' : 'postgres',
): Promise<boolean> {
  return (
    (await installedSchemaRevision(db, dialect)) === schemaRevision &&
    (await hasMatchingInputTriggers(db, dialect))
  );
}

/** Install after native schema bootstrap. Raw edits and revision advancement
 * commit together, including writers that bypass SMRT objects. The clock only
 * allocates tokens: a write advances currentness for its own entity alone. */
export async function ensureMatchingProjectionSchema(
  db: Pick<DatabaseInterface, 'query' | 'transaction' | 'url'>,
  dialect: Dialect = detectEngine(db.url) === 'sqlite' ? 'sqlite' : 'postgres',
): Promise<void> {
  // Regular init containers also use db:migrate. Avoid repeating DDL locks
  // and scanning the existing catalog once the atomic install has committed.
  const previousRevision = await installedSchemaRevision(db, dialect);
  if (
    previousRevision === schemaRevision &&
    (await hasMatchingInputTriggers(db, dialect))
  )
    return;
  if (!db.transaction)
    throw new Error('Matching schema requires transactional DDL.');
  await db.transaction(async (transaction) => {
    await transaction.query(workerCursorDdl);
    if (!(await hasSchemaRevisionColumn(transaction, dialect))) {
      await transaction.query(
        `ALTER TABLE matching_worker_cursor ADD COLUMN ${schemaVersionColumn}`,
      );
    }
    await transaction.query(
      dialect === 'postgres'
        ? 'CREATE TABLE IF NOT EXISTS matching_revision_clock (id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY)'
        : 'CREATE TABLE IF NOT EXISTS matching_revision_clock (id INTEGER PRIMARY KEY CHECK (id = 1), revision BIGINT NOT NULL)',
    );
    if (dialect === 'sqlite') {
      await transaction.query(
        'INSERT INTO matching_revision_clock (id, revision) VALUES (1, 1) ON CONFLICT (id) DO NOTHING',
      );
    }
    for (const statement of schema) await transaction.query(statement);
    await transaction.query(
      'INSERT INTO matching_vocabulary_version (id, revision) VALUES (1, 0) ON CONFLICT (id) DO NOTHING',
    );
    await transaction.query(
      "INSERT INTO matching_worker_cursor (id, source_cursor, profile_cursor) VALUES (1, '', '') ON CONFLICT (id) DO NOTHING",
    );
    await transaction.query(
      'INSERT INTO matching_source_extraction_cursor (id, work_cursor) VALUES (1, 0) ON CONFLICT (id) DO NOTHING',
    );
    await ensureInputTriggers(transaction, dialect);
    if (previousRevision > 0) {
      // A raw write may have passed through the missing trigger while the
      // schema was incomplete. Fail closed on every old result after repair.
      if (dialect === 'sqlite') {
        await transaction.query(
          'UPDATE matching_revision_clock SET revision = revision + 1 WHERE id = 1',
        );
      }
      await transaction.query(
        `UPDATE matching_vocabulary_version SET revision = ${revision(dialect)} WHERE id = 1`,
      );
    }
    for (const [raw, versions, key] of registries) {
      await transaction.query(
        `INSERT INTO ${versions} (${key}, revision)
         SELECT CAST(r.id AS TEXT), ${revision(dialect)} FROM ${raw} r
         WHERE NOT EXISTS (SELECT 1 FROM ${versions} v WHERE v.${key} = CAST(r.id AS TEXT))
         ON CONFLICT (${key}) DO NOTHING`,
      );
    }
    await transaction.query(
      'UPDATE matching_worker_cursor SET schema_revision = ? WHERE id = 1',
      [schemaRevision],
    );
  });
}
