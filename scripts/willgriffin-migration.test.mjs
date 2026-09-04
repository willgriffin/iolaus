import assert from 'node:assert/strict';
import test from 'node:test';

import {
  PostgresMigrationStore,
  SUPPORTED_SOURCE_SCHEMA_FINGERPRINT,
  SUPPORTED_TARGET_SCHEMA_FINGERPRINT,
  buildMigrationBundle,
  canonicalBootstrapTableChecksum,
  canonicalRowChecksum,
  contractFingerprint,
  derivePredecessorContract,
  exportPredecessorMigration,
  importMigrationBundle,
  loadSupportedMigrationContracts,
  parseMigrationBundle,
  planMigrationTables,
  validateDatabaseSchema,
  validateMigrationBundle,
  validateSourceTableInventory,
  withSanitizedDatabaseFailure,
} from './willgriffin-migration.mjs';

function column(name, type = 'TEXT', options = {}) {
  return {
    name,
    type,
    notNull: options.notNull ?? true,
    primaryKey: options.primaryKey ?? name === 'id',
    referencesTable: options.referencesTable ?? null,
  };
}

function table(name, columns) {
  return { name, columns };
}

function fixtureContracts() {
  const sourceContract = [
    table('tenants', [column('id', 'UUID'), column('name')]),
    table('users', [column('id', 'UUID'), column('email')]),
    table('candidate_answers', [
      column('id', 'UUID'),
      column('label'),
      column('value'),
    ]),
    table('candidate_profiles', [
      column('id', 'UUID'),
      column('user_id', 'UUID'),
    ]),
    table('sources', [
      column('id', 'UUID'),
      column('name'),
      column('is_active', 'BOOLEAN'),
    ]),
    table('source_crawls', [column('id', 'UUID'), column('source_id')]),
    table('opportunities', [
      column('id', 'UUID'),
      column('source_id'),
      column('title'),
    ]),
    table('applications', [
      column('id', 'UUID'),
      column('opportunity_id'),
      column('status'),
    ]),
    table('tasks', [
      column('id', 'UUID'),
      column('application_id'),
      column('status'),
    ]),
    table('_smrt_agent_schedules', [
      column('id', 'UUID'),
      column('enabled', 'BOOLEAN'),
      column('running_count', 'INTEGER'),
      column('next_run', 'TIMESTAMP', { notNull: false }),
    ]),
    table('_smrt_jobs', [
      column('id', 'UUID'),
      column('status'),
      column('updated_at', 'TIMESTAMP'),
      column('completed_at', 'TIMESTAMP', { notNull: false }),
      column('worker_id'),
      column('worker_heartbeat', 'TIMESTAMP', { notNull: false }),
    ]),
    table('_smrt_job_events', [
      column('id', 'UUID'),
      column('job_id', 'UUID'),
      column('message'),
    ]),
  ];
  const targetAdditions = {
    candidate_answers: [
      column('provenance', 'TEXT', { notNull: false }),
      column('saved_for_reuse_at', 'TIMESTAMP', { notNull: false }),
      column('revoked_for_reuse_at', 'TIMESTAMP', { notNull: false }),
    ],
    candidate_profiles: [
      column('facts_json'),
      column('preferences_json'),
      column('demographics_json'),
      column('resume_asset_id'),
      column('resume_source'),
      column('onboarding_completed_at', 'TIMESTAMP', { notNull: false }),
      column('demographics_consent_at', 'TIMESTAMP', { notNull: false }),
    ],
    opportunities: [
      column('missed_crawls', 'INTEGER', { notNull: false }),
      column('last_missed_at', 'TIMESTAMP', { notNull: false }),
      column('archive_reason', 'TEXT', { notNull: false }),
    ],
    source_crawls: [
      column('job_attempt', 'INTEGER', { notNull: false }),
      column('request_key', 'TEXT', { notNull: false }),
    ],
    sources: [
      column('source_role', 'TEXT', { notNull: false }),
      column('parent_source_id', 'TEXT', { notNull: false }),
      column('provider', 'TEXT', { notNull: false }),
    ],
  };
  const targetContract = sourceContract.map((source) =>
    table(source.name, [
      ...source.columns.map((field) =>
        source.name === 'sources' && field.name === 'id'
          ? { ...field, type: 'TEXT' }
          : field,
      ),
      ...(targetAdditions[source.name] || []),
    ]),
  );
  return { sourceContract, targetContract };
}

function restoredBackupShapedRows() {
  return new Map([
    ['tenants', [{ id: 'tenant-1', name: 'Owner tenant' }]],
    ['users', [{ id: 'user-1', email: 'owner@example.invalid' }]],
    [
      'candidate_answers',
      [{ id: 'answer-1', label: 'Reusable question', value: 'private-answer' }],
    ],
    ['candidate_profiles', [{ id: 'candidate-1', user_id: 'user-1' }]],
    ['sources', [{ id: 'source-1', name: 'Board', is_active: true }]],
    ['source_crawls', [{ id: 'crawl-1', source_id: 'source-1' }]],
    [
      'opportunities',
      [{ id: 'opportunity-1', source_id: 'source-1', title: 'Example role' }],
    ],
    [
      'applications',
      [
        {
          id: 'application-1',
          opportunity_id: 'opportunity-1',
          status: 'awaiting_user',
        },
      ],
    ],
    [
      'tasks',
      [{ id: 'task-1', application_id: 'application-1', status: 'done' }],
    ],
    [
      '_smrt_agent_schedules',
      [
        {
          id: 'schedule-1',
          enabled: true,
          running_count: 1,
          next_run: '2026-09-04T00:00:00.000Z',
        },
      ],
    ],
    [
      '_smrt_jobs',
      [
        {
          id: 'job-1',
          status: 'running',
          updated_at: '2026-09-04T00:00:00.000Z',
          completed_at: null,
          worker_id: 'old-worker',
          worker_heartbeat: '2026-09-04T00:00:00.000Z',
        },
      ],
    ],
    [
      '_smrt_job_events',
      [{ id: 'event-1', job_id: 'job-1', message: 'Historical event' }],
    ],
  ]);
}

class MemoryMigrationStore {
  constructor(initial = {}) {
    this.rows = new Map(
      Object.entries(initial).map(([name, rows]) => [
        name,
        new Map(rows.map((row) => [row.id, structuredClone(row)])),
      ]),
    );
    this.runs = new Map();
    this.checkpoints = new Map();
    this.rowLedger = new Map();
    this.transientCounts = new Map();
    this.ledgerInitialized = false;
    this.commits = 0;
    this.reconciliationReports = new Map();
    this.expectedBaselineCounts = {};
  }

  async assertCompatible() {}

  async assertTransientTablesEmpty(names) {
    for (const name of names) {
      if ((this.transientCounts.get(name) || 0) !== 0) {
        throw new Error(`Iolaus-only state table ${name} must be empty.`);
      }
    }
  }

  async assertFreshTarget(tables) {
    if (tables.some((table) => (this.rows.get(table.name)?.size || 0) > 0)) {
      throw new Error('Migration requires a freshly initialized target.');
    }
  }

  async ensureLedger() {
    this.ledgerInitialized = true;
  }

  async getRun(id) {
    return this.runs.get(id) || null;
  }

  async hasCommittedRows(runId) {
    return [...this.rowLedger.keys()].some((key) => key.startsWith(`${runId}:`));
  }

  async createRun(bundle) {
    this.runs.set(bundle.runId, {
      sourceFingerprint: bundle.sourceFingerprint,
      sourceSchemaFingerprint: bundle.sourceSchemaFingerprint,
      targetSchemaFingerprint: bundle.targetSchemaFingerprint,
      status: 'running',
    });
  }

  async getCheckpoint(runId, tableName) {
    return structuredClone(this.checkpoints.get(`${runId}:${tableName}`) || null);
  }

  async getTargetRow(tableDefinition, id) {
    const row = this.rows.get(tableDefinition.name)?.get(id);
    if (!row) return null;
    return Object.fromEntries(
      tableDefinition.columns.map((field) => [field.name, row[field.name]]),
    );
  }

  async listTargetRows(tableDefinition) {
    return [...(this.rows.get(tableDefinition.name)?.values() || [])].map((row) =>
      Object.fromEntries(
        tableDefinition.columns.map((field) => [field.name, row[field.name]]),
      ),
    );
  }

  async getReconciliationReport(runId) {
    return structuredClone(this.reconciliationReports.get(runId) || null);
  }

  async getUpdatedRows(runId) {
    return [...this.rowLedger.entries()]
      .filter(
        ([key, value]) => key.startsWith(`${runId}:`) && value.action === 'update',
      )
      .map(([key]) => {
        const [, tableName, ...sourceId] = key.split(':');
        return { table: tableName, sourceId: sourceId.join(':') };
      });
  }

  async recordReconciliation(runId, report) {
    this.reconciliationReports.set(runId, structuredClone(report));
  }

  async commitBatch(input) {
    const tableRows = this.rows.get(input.table.name) || new Map();
    for (const operation of input.operations) {
      if (operation.action !== 'skip') {
        tableRows.set(operation.targetId, structuredClone(operation.targetValues));
      }
      this.rowLedger.set(
        `${input.runId}:${input.table.name}:${operation.sourceId}`,
        {
          sourceChecksum: operation.sourceChecksum,
          targetChecksum: operation.targetChecksum,
          action: operation.action,
        },
      );
    }
    this.rows.set(input.table.name, tableRows);
    this.checkpoints.set(`${input.runId}:${input.table.name}`, {
      cursor: input.cursor,
      counts: structuredClone(input.counts),
      complete: input.complete,
    });
    this.commits += 1;
  }

  async completeRun(runId, digest) {
    this.runs.set(runId, {
      ...this.runs.get(runId),
      status: 'complete',
      reconciliationDigest: digest,
    });
  }
}

test('pinned manifests produce the explicitly approved predecessor contract', async () => {
  const { sourceContract, targetContract } = await loadSupportedMigrationContracts(
    process.cwd(),
  );
  const migratedNames = new Set(sourceContract.map((entry) => entry.name));
  assert.equal(sourceContract.length, 101);
  assert.equal(
    contractFingerprint(sourceContract),
    SUPPORTED_SOURCE_SCHEMA_FINGERPRINT,
  );
  assert.equal(
    contractFingerprint(
      targetContract.filter((entry) => migratedNames.has(entry.name)),
    ),
    SUPPORTED_TARGET_SCHEMA_FINGERPRINT,
  );
  assert.deepEqual(
    derivePredecessorContract(targetContract).map((entry) => entry.name),
    sourceContract.map((entry) => entry.name),
  );
  assert.deepEqual(
    sourceContract.find((entry) => entry.name === 'profiles').uniqueKeys,
    [['tenant_id', 'slug', 'context', '_meta_type']],
  );
  assert.deepEqual(
    sourceContract.find((entry) => entry.name === 'fact_contents').uniqueKeys,
    [['fact_id', 'content_id', 'relationship']],
  );
  const plan = planMigrationTables(sourceContract);
  const position = new Map(plan.map((entry, index) => [entry.name, index]));
  for (const entry of plan) {
    for (const field of entry.columns) {
      if (
        field.referencesTable &&
        field.referencesTable !== entry.name &&
        position.has(field.referencesTable)
      ) {
        assert.ok(
          position.get(field.referencesTable) < position.get(entry.name),
          `${field.referencesTable} must precede ${entry.name}`,
        );
      }
    }
  }
});

test('predecessor table inventory permits only migrated or explicitly excluded tables', () => {
  const contract = [table('tenants', [column('id', 'UUID')])];
  assert.doesNotThrow(() =>
    validateSourceTableInventory(['tenants', '_smrt_migrations'], contract),
  );
  assert.throws(
    () => validateSourceTableInventory(['tenants', 'unexpected_private_table'], contract),
    /table inventory is incompatible/,
  );
  assert.throws(
    () => validateSourceTableInventory(['_smrt_migrations'], contract),
    /table inventory is incompatible/,
  );
});

test('synthetic migration is deterministic, preserves ids, and reruns without changes', async () => {
  const { sourceContract, targetContract } = fixtureContracts();
  const sourceRows = restoredBackupShapedRows();
  const firstBundle = buildMigrationBundle({
    sourceRows,
    sourceContract,
    targetContract,
    exportedAt: '2026-09-04T00:00:00.000Z',
  });
  const secondBundle = buildMigrationBundle({
    sourceRows,
    sourceContract,
    targetContract,
    exportedAt: '2026-09-05T00:00:00.000Z',
  });
  assert.equal(firstBundle.sourceFingerprint, secondBundle.sourceFingerprint);
  assert.equal(firstBundle.runId, secondBundle.runId);

  const store = new MemoryMigrationStore();
  const first = await importMigrationBundle({
    bundle: firstBundle,
    sourceContract,
    targetContract,
    store,
    batchSize: 2,
  });
  const second = await importMigrationBundle({
    bundle: secondBundle,
    sourceContract,
    targetContract,
    store,
    batchSize: 2,
  });

  assert.equal(first.counts.inserted, 12);
  assert.equal(first.counts.skipped, 0);
  assert.deepEqual(second.counts, {
    attempted: 0,
    inserted: 0,
    updated: 0,
    skipped: 0,
  });
  assert.equal(first.reconciliationDigest, second.reconciliationDigest);
  assert.equal(
    first.reconciliation.reportDigest,
    second.reconciliation.reportDigest,
  );
  assert.equal(store.rows.get('sources').get('source-1').id, 'source-1');
  assert.deepEqual(store.rows.get('sources').get('source-1'), {
    id: 'source-1',
    name: 'Board',
    is_active: true,
    source_role: 'root',
    parent_source_id: null,
    provider: 'unknown',
  });
  assert.equal(
    store.rows.get('candidate_answers').get('answer-1').provenance,
    'legacy_reusable_answer',
  );
  assert.equal(
    store.rows.get('candidate_profiles').get('candidate-1').resume_source,
    'not_selected',
  );
});

test('restored-backup-shaped fixture resumes from a committed cursor and stays inert', async () => {
  const { sourceContract, targetContract } = fixtureContracts();
  const bundle = buildMigrationBundle({
    sourceRows: restoredBackupShapedRows(),
    sourceContract,
    targetContract,
  });
  const store = new MemoryMigrationStore();
  let committed = 0;
  await assert.rejects(
    importMigrationBundle({
      bundle,
      sourceContract,
      targetContract,
      store,
      batchSize: 1,
      onBatchCommitted() {
        committed += 1;
        if (committed === 3) throw new Error('synthetic interruption');
      },
    }),
    /synthetic interruption/,
  );
  const beforeResumeCommits = store.commits;
  const resumed = await importMigrationBundle({
    bundle,
    sourceContract,
    targetContract,
    store,
    batchSize: 1,
  });
  assert.ok(store.commits > beforeResumeCommits);
  assert.equal(store.rows.get('users').get('user-1').email, 'owner@example.invalid');
  assert.equal(store.rows.get('_smrt_jobs').get('job-1').status, 'cancelled');
  assert.equal(store.rows.get('_smrt_jobs').get('job-1').worker_id, '');
  assert.equal(
    store.rows.get('_smrt_agent_schedules').get('schedule-1').enabled,
    false,
  );
  const verification = await importMigrationBundle({
    bundle,
    sourceContract,
    targetContract,
    store,
    batchSize: 1,
  });
  assert.equal(resumed.reconciliationDigest, verification.reconciliationDigest);
  assert.equal(
    resumed.reconciliation.reportDigest,
    verification.reconciliation.reportDigest,
  );
  assert.equal(verification.counts.attempted, 0);
});

test('self-referential rows are parent-first and resume by ordered cursor', async () => {
  const nodes = table('tenants', [
    column('id', 'UUID'),
    column('parent_tenant_id', 'UUID', {
      notNull: false,
      referencesTable: 'tenants',
    }),
  ]);
  const sourceContract = [nodes];
  const targetContract = structuredClone(sourceContract);
  const bundle = buildMigrationBundle({
    sourceContract,
    targetContract,
    sourceRows: new Map([
      [
        'tenants',
        [
          { id: 'child-a', parent_tenant_id: 'parent-z' },
          { id: 'parent-z', parent_tenant_id: null },
        ],
      ],
    ]),
  });
  assert.deepEqual(
    bundle.tables[0].rows.map((row) => row.sourceId),
    ['parent-z', 'child-a'],
  );
  const store = new MemoryMigrationStore();
  await assert.rejects(
    importMigrationBundle({
      bundle,
      sourceContract,
      targetContract,
      store,
      batchSize: 1,
      onBatchCommitted() {
        throw new Error('synthetic interruption');
      },
    }),
    /synthetic interruption/,
  );
  const resumed = await importMigrationBundle({
    bundle,
    sourceContract,
    targetContract,
    store,
    batchSize: 1,
  });
  assert.equal(resumed.counts.inserted, 1);
  assert.equal(store.rows.get('tenants').size, 2);

  assert.doesNotThrow(() =>
    buildMigrationBundle({
      sourceContract,
      targetContract,
      sourceRows: new Map([
        ['tenants', [{ id: 'orphan', parent_tenant_id: 'missing' }]],
      ]),
    }),
  );
});

test('dry-run reports changes without creating a ledger or mutating target rows', async () => {
  const { sourceContract, targetContract } = fixtureContracts();
  const bundle = buildMigrationBundle({
    sourceRows: restoredBackupShapedRows(),
    sourceContract,
    targetContract,
  });
  const store = new MemoryMigrationStore();
  store.withMigrationLease = async () => {
    throw new Error('dry-run must not acquire a database lease');
  };
  const report = await importMigrationBundle({
    bundle,
    sourceContract,
    targetContract,
    store,
    dryRun: true,
  });
  assert.equal(report.status, 'dry-run');
  assert.equal(report.counts.inserted, 12);
  assert.equal(store.rows.size, 0);
  assert.equal(store.ledgerInitialized, false);
});

test('a new or ledger-empty migration run refuses a populated migrated target', async () => {
  const { sourceContract, targetContract } = fixtureContracts();
  const bundle = buildMigrationBundle({
    sourceRows: restoredBackupShapedRows(),
    sourceContract,
    targetContract,
  });
  const store = new MemoryMigrationStore({
    tenants: [{ id: 'unrelated-target-row', name: 'Existing target' }],
  });
  store.runs.set(bundle.runId, {
    sourceFingerprint: bundle.sourceFingerprint,
    sourceSchemaFingerprint: bundle.sourceSchemaFingerprint,
    targetSchemaFingerprint: bundle.targetSchemaFingerprint,
    status: 'running',
  });
  await assert.rejects(
    importMigrationBundle({
      bundle,
      sourceContract,
      targetContract,
      store,
    }),
    /requires a freshly initialized target/,
  );
});

test('migration refuses populated target-only DataSurface state', async () => {
  const { sourceContract, targetContract } = fixtureContracts();
  const bundle = buildMigrationBundle({
    sourceRows: restoredBackupShapedRows(),
    sourceContract,
    targetContract,
  });
  const store = new MemoryMigrationStore();
  store.transientCounts.set('data_surface_idempotency', 1);
  await assert.rejects(
    importMigrationBundle({ bundle, sourceContract, targetContract, store }),
    /must be empty/,
  );
  assert.equal(store.ledgerInitialized, false);
});

test('schema and bundle compatibility fail closed without exposing private values', () => {
  const { sourceContract, targetContract } = fixtureContracts();
  const sourceRows = restoredBackupShapedRows();
  const bundle = buildMigrationBundle({
    sourceRows,
    sourceContract,
    targetContract,
  });
  const tampered = structuredClone(bundle);
  tampered.tables.find((entry) => entry.name === 'candidate_answers').rows[0].values.value =
    'do-not-print-this-value';
  assert.throws(
    () => validateMigrationBundle(tampered, sourceContract, targetContract),
    (error) =>
      !String(error.message).includes('do-not-print-this-value') &&
      /validation failed/.test(error.message),
  );

  const alteredInventory = structuredClone(bundle);
  alteredInventory.excludedTables = [];
  assert.throws(
    () =>
      validateMigrationBundle(
        alteredInventory,
        sourceContract,
        targetContract,
      ),
    /exclusion inventory is incompatible/,
  );

  assert.throws(
    () =>
      validateDatabaseSchema(
        [
          {
            tableName: 'tenants',
            columnName: 'id',
            dataType: 'uuid',
            isNullable: 'NO',
          },
        ],
        [table('tenants', [column('id', 'UUID'), column('private_field')])],
        'Predecessor schema',
      ),
    /columns are incompatible/,
  );

  assert.doesNotThrow(() =>
    validateDatabaseSchema(
      [
        {
          tableName: 'tenants',
          columnName: 'id',
          dataType: 'uuid',
          isNullable: 'NO',
        },
        {
          tableName: 'tenants',
          columnName: 'optional_label',
          dataType: 'text',
          isNullable: 'NO',
        },
      ],
      [
        table('tenants', [
          column('id', 'UUID'),
          column('optional_label', 'TEXT', { notNull: false }),
        ]),
      ],
      'Iolaus target schema',
    ),
  );

  assert.throws(
    () =>
      validateDatabaseSchema(
        [
          {
            tableName: 'tenants',
            columnName: 'id',
            dataType: 'uuid',
            isNullable: 'YES',
          },
        ],
        [table('tenants', [column('id', 'UUID')])],
        'Iolaus target schema',
      ),
    /column type is incompatible/,
  );

  assert.doesNotThrow(() =>
    validateDatabaseSchema(
      [
        {
          tableName: 'tenants',
          columnName: 'id',
          dataType: 'uuid',
          isNullable: 'NO',
          isGenerated: 'NEVER',
        },
        {
          tableName: 'tenants',
          columnName: '_integrity_id_text',
          dataType: 'text',
          isNullable: 'YES',
          isGenerated: 'ALWAYS',
        },
      ],
      [table('tenants', [column('id', 'UUID')])],
      'Iolaus target schema',
    ),
  );
});

test('malformed private bundles fail without echoing their contents', () => {
  assert.throws(
    () => parseMigrationBundle('{"candidate":"private-marker",broken}'),
    (error) =>
      !String(error.message).includes('private-marker') &&
      /not valid JSON/.test(error.message),
  );
});

test('database boundary failures do not expose driver details', async () => {
  await assert.rejects(
    withSanitizedDatabaseFailure('Migration database operation failed.', async () => {
      throw new Error('private-marker at postgresql://private-host/private-db');
    }),
    (error) =>
      !String(error.message).includes('private-marker') &&
      !String(error.message).includes('private-host') &&
      /database operation failed/.test(error.message),
  );
});

test('source bundle preserves encrypted Nostr identity fields without logging values', () => {
  const sourceContract = [
    table('nostr_identities', [
      column('id', 'UUID'),
      column('pubkey'),
      column('encrypted_privkey'),
      column('encryption_iv'),
      column('encryption_tag'),
    ]),
  ];
  const targetContract = structuredClone(sourceContract);
  const bundle = buildMigrationBundle({
    sourceContract,
    targetContract,
    sourceRows: new Map([
      [
        'nostr_identities',
        [
          {
            id: 'identity-1',
            pubkey: 'public-key',
            encrypted_privkey: 'private-marker',
            encryption_iv: 'iv-marker',
            encryption_tag: 'tag-marker',
          },
        ],
      ],
    ]),
  });
  const values = bundle.tables[0].rows[0].values;
  assert.equal(values.encrypted_privkey, 'private-marker');
  assert.equal(values.encryption_iv, 'iv-marker');
  assert.equal(values.encryption_tag, 'tag-marker');
  assert.equal(bundle.tables[0].rows[0].checksum, canonicalRowChecksum(values));
  const tampered = structuredClone(bundle);
  tampered.tables[0].rows[0].values.encrypted_privkey = 'changed-private-marker';
  assert.throws(
    () => validateMigrationBundle(tampered, sourceContract, targetContract),
    (error) =>
      !String(error.message).includes('changed-private-marker') &&
      /validation failed/.test(error.message),
  );
});

test('export refuses any source that is not explicitly attested as an isolated restore', async () => {
  await assert.rejects(
    exportPredecessorMigration({
      env: {},
      path: '/tmp/example-migration.json',
      sourceRoot: process.cwd(),
    }),
    /verified isolated restore/,
  );
  await assert.rejects(
    exportPredecessorMigration({
      env: {
        DATABASE_URL: 'postgresql://target.example.invalid/iolaus',
        WILLGRIFFIN_MIGRATION_SOURCE_DATABASE_URL:
          'postgresql://user:private-marker@production.example.invalid/willgriffin',
        WILLGRIFFIN_MIGRATION_SOURCE_ISOLATED_RESTORE: 'true',
      },
      path: '/tmp/example-migration.json',
      sourceRoot: process.cwd(),
    }),
    (error) =>
      !String(error.message).includes('private-marker') &&
      /requires a local database/.test(error.message),
  );
});

test('export refuses connection parameters that can override the isolated restore endpoint', async () => {
  await assert.rejects(
    exportPredecessorMigration({
      env: {
        DATABASE_URL: 'postgresql://target.example.invalid/iolaus',
        WILLGRIFFIN_MIGRATION_SOURCE_DATABASE_URL:
          'postgresql://user:private-marker@localhost/willgriffin_restore?host=production.example.invalid',
        WILLGRIFFIN_MIGRATION_SOURCE_ISOLATED_RESTORE: 'true',
      },
      path: '/tmp/example-migration.json',
      sourceRoot: process.cwd(),
    }),
    (error) =>
      !String(error.message).includes('private-marker') &&
      !String(error.message).includes('production.example.invalid') &&
      /requires a local database/.test(error.message),
  );
  await assert.rejects(
    exportPredecessorMigration({
      env: {
        DATABASE_URL: 'postgresql://target.example.invalid/iolaus',
        WILLGRIFFIN_MIGRATION_SOURCE_DATABASE_URL:
          'postgresql:///willgriffin_restore',
        WILLGRIFFIN_MIGRATION_SOURCE_ISOLATED_RESTORE: 'true',
      },
      path: '/tmp/example-migration.json',
      sourceRoot: process.cwd(),
    }),
    /requires a local database/,
  );
});

test('PostgreSQL migration lease recovers stale rows through a session lock', async () => {
  const statements = [];
  let released = false;
  const session = {
    async query(sql) {
      statements.push(sql);
      if (sql.includes('pg_try_advisory_lock')) {
        return { rows: [{ acquired: true }] };
      }
      return { rows: [] };
    },
    async release() {
      released = true;
    },
  };
  const store = new PostgresMigrationStore({
    async query() {
      return { rows: [] };
    },
    async acquireSession() {
      return session;
    },
  });

  assert.equal(await store.withMigrationLease('run-a', async () => 'done'), 'done');
  assert.ok(
    statements.some(
      (sql) => sql.includes('ON CONFLICT (lease_name) DO UPDATE'),
    ),
  );
  assert.ok(statements.some((sql) => sql.includes('pg_advisory_unlock')));
  assert.equal(released, true);
});

test('PostgreSQL batches bind target, row-ledger, and checkpoint writes', async () => {
  const calls = [];
  const tx = {
    async query(sql, parameters) {
      calls.push({ sql, parameters });
      if (sql.includes('FROM _iolaus_migration_leases')) {
        return { rows: [{ holder: 'holder-1' }] };
      }
      return { rows: [] };
    },
  };
  const store = new PostgresMigrationStore({
    async transaction(callback) {
      return await callback(tx);
    },
  });
  store.migrationLease = { holder: 'holder-1', runId: 'run-1' };
  await store.commitBatch({
    runId: 'run-1',
    table: table('users', [column('id', 'UUID'), column('email')]),
    operations: [
      {
        action: 'insert',
        sourceId: 'user-1',
        sourceChecksum: 'a'.repeat(64),
        targetChecksum: 'b'.repeat(64),
        targetValues: { id: 'user-1', email: 'owner@example.invalid' },
      },
    ],
    cursor: 'user-1',
    counts: { attempted: 1, inserted: 1, updated: 0, skipped: 0 },
    complete: true,
    tableChecksum: 'c'.repeat(64),
  });
  assert.equal(calls.length, 4);
  assert.match(calls[0].sql, /FOR UPDATE/);
  assert.match(calls[1].sql, /ON CONFLICT \("id"\) DO UPDATE/);
  assert.deepEqual(calls[1].parameters, [
    'user-1',
    'owner@example.invalid',
  ]);
  assert.equal(calls[2].parameters[2], 'user-1');
  assert.deepEqual(calls[3].parameters.slice(3, 7), [1, 1, 0, 0]);
});

test('PostgreSQL batches reject a replaced lease before target writes', async () => {
  const statements = [];
  const store = new PostgresMigrationStore({
    async transaction(callback) {
      return await callback({
        async query(sql) {
          statements.push(sql);
          return { rows: [] };
        },
      });
    },
  });
  store.migrationLease = { holder: 'former-holder', runId: 'run-1' };

  await assert.rejects(
    store.commitBatch({
      runId: 'run-1',
      table: table('users', [column('id', 'UUID'), column('email')]),
      operations: [],
      cursor: '',
      counts: { attempted: 0, inserted: 0, updated: 0, skipped: 0 },
      complete: true,
      tableChecksum: 'c'.repeat(64),
    }),
    /batch write failed/,
  );
  assert.equal(statements.length, 1);
  assert.match(statements[0], /FOR UPDATE/);
});

test('PostgreSQL batches reject a lost advisory-lock session', async () => {
  const statements = [];
  const store = new PostgresMigrationStore({
    async transaction(callback) {
      return await callback({
        async query(sql) {
          statements.push(sql);
          return { rows: [{ holder: 'former-holder' }] };
        },
      });
    },
  });
  store.migrationLease = {
    holder: 'former-holder',
    runId: 'run-1',
    session: { isActive: () => false },
  };

  await assert.rejects(
    store.commitBatch({
      runId: 'run-1',
      table: table('users', [column('id', 'UUID'), column('email')]),
      operations: [],
      cursor: '',
      counts: { attempted: 0, inserted: 0, updated: 0, skipped: 0 },
      complete: true,
      tableChecksum: 'c'.repeat(64),
    }),
    /batch write failed/,
  );
  assert.equal(statements.length, 0);
});

test('PostgreSQL target reads normalize values by their logical schema types', async () => {
  const store = new PostgresMigrationStore({
    async query() {
      return {
        rows: [
          {
            id: 'stable-id',
            count: '9007199254740993',
            score: '1.5',
            enabled: 't',
            metadata: '{"synthetic":true}',
          },
        ],
      };
    },
  });
  assert.deepEqual(
    await store.getTargetRow(
      table('typed_rows', [
        column('id'),
        column('count', 'INTEGER'),
        column('score', 'REAL'),
        column('enabled', 'BOOLEAN'),
        column('metadata', 'JSON'),
      ]),
      'stable-id',
    ),
    {
      id: 'stable-id',
      count: '9007199254740993',
      score: 1.5,
      enabled: true,
      metadata: { synthetic: true },
    },
  );
});

test('logical target checksums normalize database scalar representations', async () => {
  const scores = table('achievements', [column('id'), column('score', 'REAL')]);
  const sourceContract = [scores];
  const targetContract = structuredClone(sourceContract);
  const bundle = buildMigrationBundle({
    sourceContract,
    targetContract,
    sourceRows: new Map([
      ['achievements', [{ id: 'score-1', score: '1.5' }]],
    ]),
  });
  const store = new MemoryMigrationStore({
    achievements: [{ id: 'score-1', score: 1.5 }],
  });
  store.runs.set(bundle.runId, {
    sourceFingerprint: bundle.sourceFingerprint,
    sourceSchemaFingerprint: bundle.sourceSchemaFingerprint,
    targetSchemaFingerprint: bundle.targetSchemaFingerprint,
    status: 'running',
  });
  store.rowLedger.set(`${bundle.runId}:achievements:score-1`, {});
  const result = await importMigrationBundle({
    bundle,
    sourceContract,
    targetContract,
    store,
  });
  assert.deepEqual(result.counts, {
    attempted: 1,
    inserted: 0,
    updated: 0,
    skipped: 1,
  });
});

test('stable-ID updates remain reconciled across retries', async () => {
  const achievements = table('achievements', [column('id'), column('title')]);
  const sourceContract = [achievements];
  const targetContract = structuredClone(sourceContract);
  const bundle = buildMigrationBundle({
    sourceContract,
    targetContract,
    sourceRows: new Map([
      ['achievements', [{ id: 'achievement-1', title: 'Source title' }]],
    ]),
  });
  const store = new MemoryMigrationStore({
    achievements: [{ id: 'achievement-1', title: 'Target title' }],
  });
  store.runs.set(bundle.runId, {
    sourceFingerprint: bundle.sourceFingerprint,
    sourceSchemaFingerprint: bundle.sourceSchemaFingerprint,
    targetSchemaFingerprint: bundle.targetSchemaFingerprint,
    status: 'running',
  });
  store.rowLedger.set(`${bundle.runId}:bootstrap:sentinel`, { action: 'insert' });
  const first = await importMigrationBundle({
    bundle,
    sourceContract,
    targetContract,
    store,
  });
  const retry = await importMigrationBundle({
    bundle,
    sourceContract,
    targetContract,
    store,
  });
  assert.equal(first.reconciliation.collisions.length, 1);
  assert.equal(
    first.reconciliation.reportDigest,
    retry.reconciliation.reportDigest,
  );
  assert.doesNotMatch(
    JSON.stringify(retry.reconciliation.collisions),
    /achievement-1/,
  );
});

test('target checksums include classified bootstrap rows and reject unexplained extras', async () => {
  const achievements = table('achievements', [column('id'), column('title')]);
  const sourceContract = [achievements];
  const targetContract = structuredClone(sourceContract);
  const bundle = buildMigrationBundle({
    sourceContract,
    targetContract,
    sourceRows: new Map([
      ['achievements', [{ id: 'source-row', title: 'Source' }]],
    ]),
  });
  const unexpected = new MemoryMigrationStore({
    achievements: [
      { id: 'source-row', title: 'Source' },
      { id: 'unexpected-row', title: 'Unexpected' },
    ],
  });
  unexpected.runs.set(bundle.runId, {
    sourceFingerprint: bundle.sourceFingerprint,
    sourceSchemaFingerprint: bundle.sourceSchemaFingerprint,
    targetSchemaFingerprint: bundle.targetSchemaFingerprint,
    status: 'running',
  });
  unexpected.rowLedger.set(`${bundle.runId}:bootstrap:sentinel`, {
    action: 'insert',
  });
  await assert.rejects(
    importMigrationBundle({
      bundle,
      sourceContract,
      targetContract,
      store: unexpected,
    }),
    /unexplained rows/,
  );

  const bootstrapBundle = buildMigrationBundle({
    sourceContract,
    targetContract,
    sourceRows: new Map([['achievements', []]]),
  });
  const classified = new MemoryMigrationStore({
    achievements: [{ id: 'bootstrap-row', title: 'Bootstrap' }],
  });
  classified.expectedBaselineCounts = { achievements: 1 };
  classified.runs.set(bootstrapBundle.runId, {
    sourceFingerprint: bootstrapBundle.sourceFingerprint,
    sourceSchemaFingerprint: bootstrapBundle.sourceSchemaFingerprint,
    targetSchemaFingerprint: bootstrapBundle.targetSchemaFingerprint,
    status: 'running',
  });
  classified.rowLedger.set(`${bootstrapBundle.runId}:bootstrap:sentinel`, {
    action: 'insert',
  });
  const report = await importMigrationBundle({
    bundle: bootstrapBundle,
    sourceContract,
    targetContract,
    store: classified,
  });
  assert.equal(report.reconciliation.tables[0].retainedTargetRows, 1);
  assert.equal(report.reconciliation.tables[0].targetRowCount, 1);
  assert.equal(report.reconciliation.tables[0].targetChecksum.length, 64);
});

test('PostgreSQL batch failures do not expose bound private values', async () => {
  const store = new PostgresMigrationStore({
    async transaction(callback) {
      return await callback({
        async query() {
          throw new Error('driver echoed private-marker');
        },
      });
    },
  });
  await assert.rejects(
    store.commitBatch({
      runId: 'run-1',
      table: table('candidate_answers', [column('id'), column('value')]),
      operations: [
        {
          action: 'insert',
          sourceId: 'answer-1',
          sourceChecksum: 'a'.repeat(64),
          targetChecksum: 'b'.repeat(64),
          targetValues: { id: 'answer-1', value: 'private-marker' },
        },
      ],
      cursor: 'answer-1',
      counts: { attempted: 1, inserted: 1, updated: 0, skipped: 0 },
      complete: true,
      tableChecksum: 'c'.repeat(64),
    }),
    (error) =>
      !String(error.message).includes('private-marker') &&
      /candidate_answers/.test(error.message),
  );
});

test('PostgreSQL fresh-target validation binds bootstrap identity and contents', async () => {
  const store = new PostgresMigrationStore({
    async query() {
      return { rows: [{ id: 'arbitrary-row' }] };
    },
  });
  await assert.rejects(
    store.assertFreshTarget([
      table('candidate_profiles', [column('id')]),
    ]),
    /freshly initialized target/,
  );
});

test('bootstrap checksums ignore generated ids but bind semantic references', () => {
  const roles = table('roles', [column('id', 'UUID'), column('slug')]);
  const grants = table('role_permissions', [
    column('id', 'UUID'),
    column('slug'),
    column('role_id', 'UUID', { referencesTable: 'roles' }),
  ]);
  const contracts = new Map([
    ['roles', roles],
    ['role_permissions', grants],
  ]);
  const checksum = (roleId, grantId, roleSlug) => {
    const rows = new Map([
      ['roles', [{ id: roleId, slug: roleSlug }]],
      [
        'role_permissions',
        [{ id: grantId, slug: grantId, role_id: roleId }],
      ],
    ]);
    return canonicalBootstrapTableChecksum(
      rows.get('role_permissions'),
      grants,
      rows,
      contracts,
    );
  };
  assert.equal(checksum('role-1', 'grant-1', 'owner'), checksum('role-2', 'grant-2', 'owner'));
  assert.notEqual(
    checksum('role-1', 'grant-1', 'owner'),
    checksum('role-2', 'grant-2', 'viewer'),
  );
});

test('bootstrap checksums ignore audit clocks but bind semantic timestamps', () => {
  const controls = table('opportunity_intelligence_controls', [
    column('id', 'UUID'),
    column('created_at', 'TIMESTAMP'),
    column('updated_at', 'TIMESTAMP'),
    column('window_started_at', 'TIMESTAMP'),
    column('last_request_at', 'TIMESTAMP', { notNull: false }),
  ]);
  const contracts = new Map([[controls.name, controls]]);
  const checksum = (row) => {
    const rows = new Map([[controls.name, [row]]]);
    return canonicalBootstrapTableChecksum(
      rows.get(controls.name),
      controls,
      rows,
      contracts,
    );
  };
  const pristine = {
    id: 'generated-a',
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    window_started_at: '2026-01-01T00:00:00.000Z',
    last_request_at: null,
  };
  assert.equal(
    checksum(pristine),
    checksum({
      ...pristine,
      id: 'generated-b',
      created_at: '2027-01-01T00:00:00.000Z',
      updated_at: '2027-01-01T00:00:00.000Z',
      window_started_at: '2027-01-01T00:00:00.000Z',
    }),
  );
  assert.notEqual(
    checksum(pristine),
    checksum({
      ...pristine,
      last_request_at: '2026-01-01T00:01:00.000Z',
    }),
  );
});

test('source bootstrap catalogs reconcile onto fresh target identities', async () => {
  const roles = table('roles', [column('id', 'UUID'), column('slug')]);
  roles.uniqueKeys = [['slug']];
  const grants = table('role_permissions', [
    column('id', 'UUID'),
    column('slug'),
    column('role_id', 'UUID', { referencesTable: 'roles' }),
    column('permission_id', 'UUID'),
  ]);
  grants.uniqueKeys = [['slug']];
  const sourceContract = [roles, grants];
  const targetContract = structuredClone(sourceContract);
  const bundle = buildMigrationBundle({
    sourceContract,
    targetContract,
    sourceRows: new Map([
      ['roles', [{ id: 'source-role', slug: 'owner' }]],
      [
        'role_permissions',
        [
          {
            id: 'source-grant',
            slug: 'source-grant',
            role_id: 'source-role',
            permission_id: 'permission-a',
          },
        ],
      ],
    ]),
  });
  const store = new MemoryMigrationStore({
    roles: [{ id: 'target-role', slug: 'owner' }],
    role_permissions: [
      {
        id: 'target-grant',
        slug: 'target-grant',
        role_id: 'target-role',
        permission_id: 'permission-a',
      },
    ],
  });
  store.expectedBaselineCounts = { role_permissions: 1, roles: 1 };
  store.assertFreshTarget = async () => {};

  const result = await importMigrationBundle({
    bundle,
    sourceContract,
    targetContract,
    store,
  });

  assert.equal(store.rows.get('roles').size, 1);
  assert.equal(store.rows.get('role_permissions').size, 1);
  assert.equal(
    store.rows.get('role_permissions').get('target-grant').role_id,
    'target-role',
  );
  assert.equal(
    store.rows.get('role_permissions').get('target-grant').slug,
    'target-grant',
  );
  assert.equal(result.reconciliation.collisions.length, 2);
  assert.doesNotMatch(JSON.stringify(result.reconciliation), /source-role|source-grant/);
});

test('bootstrap remaps reach semantic relationships absent from manifest FKs', async () => {
  const tags = table('tags', [column('id', 'UUID'), column('slug')]);
  tags.uniqueKeys = [['slug']];
  const achievements = table('achievements', [
    column('id', 'UUID'),
    column('slug'),
  ]);
  achievements.uniqueKeys = [['slug']];
  const edges = table('achievement_tags', [
    column('id', 'UUID'),
    column('slug'),
    column('achievement_id', 'UUID'),
    column('tag_id', 'UUID'),
  ]);
  edges.uniqueKeys = [['slug']];
  const sourceContract = [tags, achievements, edges];
  const targetContract = structuredClone(sourceContract);
  const bundle = buildMigrationBundle({
    sourceContract,
    targetContract,
    sourceRows: new Map([
      ['tags', [{ id: 'source-tag', slug: 'engineering' }]],
      ['achievements', [{ id: 'achievement-a', slug: 'achievement-a' }]],
      [
        'achievement_tags',
        [
          {
            id: 'edge-a',
            slug: 'edge-a',
            achievement_id: 'achievement-a',
            tag_id: 'source-tag',
          },
        ],
      ],
    ]),
  });
  const baseline = {
    tags: [{ id: 'target-tag', slug: 'engineering' }],
  };
  const dryStore = new MemoryMigrationStore(baseline);
  dryStore.expectedBaselineCounts = { tags: 1 };
  dryStore.assertFreshTarget = async () => {};
  const store = new MemoryMigrationStore(baseline);
  store.expectedBaselineCounts = { tags: 1 };
  store.assertFreshTarget = async () => {};

  const dryResult = await importMigrationBundle({
    bundle,
    sourceContract,
    targetContract,
    store: dryStore,
    dryRun: true,
  });
  const result = await importMigrationBundle({
    bundle,
    sourceContract,
    targetContract,
    store,
  });

  assert.equal(
    store.rows.get('achievement_tags').get('edge-a').tag_id,
    'target-tag',
  );
  const dryTags = dryResult.reconciliation.tables.find(
    (entry) => entry.name === 'tags',
  );
  const tagsResult = result.reconciliation.tables.find(
    (entry) => entry.name === 'tags',
  );
  assert.equal(dryTags.targetRowCount, 1);
  assert.equal(dryTags.targetChecksum, tagsResult.targetChecksum);
  assert.equal(
    dryResult.reconciliationDigest,
    result.reconciliationDigest,
  );
  assert.equal(dryStore.rows.get('tags').size, 1);
  assert.equal(dryStore.rows.get('achievement_tags')?.size || 0, 0);
});

test('PostgreSQL finalization locks and rechecks the complete target snapshot', async () => {
  const statements = [];
  const store = new PostgresMigrationStore({
    async transaction(callback) {
      return await callback({
        async query(sql) {
          statements.push(sql);
          if (sql.includes('FROM _iolaus_migration_leases')) {
            return { rows: [{ holder: 'holder-1' }] };
          }
          if (sql.includes('SELECT')) return { rows: [{ id: 'changed-row' }] };
          return { rows: [] };
        },
      });
    },
  });
  store.migrationLease = { holder: 'holder-1', runId: 'run' };
  await assert.rejects(
    store.finalizeRun({
      runId: 'run',
      digest: 'a'.repeat(64),
      report: { quarantine: [], reportDigest: 'b'.repeat(64) },
      tableContracts: [table('achievements', [column('id')])],
      expectedChecksums: new Map([['achievements', 'c'.repeat(64)]]),
    }),
    /final reconciliation failed/,
  );
  assert.ok(statements[0].includes('FOR UPDATE'));
  assert.ok(statements[1].includes('LOCK TABLE'));
  assert.ok(!statements.some((sql) => sql.includes("SET status = 'complete'")));
});
