import assert from 'node:assert/strict';
import test from 'node:test';

import { buildMigrationBundle } from './willgriffin-migration.mjs';
import {
  INTENTIONAL_MIGRATION_EXCLUSIONS,
  RECONCILIATION_REASON_CODES,
  SMRT_UPGRADE_HAZARDS,
  finalizeReconciliationReport,
  reconcileAssetInventory,
  reconcileMigrationRows,
  recordStableIdCollision,
} from './willgriffin-reconciliation.mjs';

const IDS = Object.freeze({
  a: '00000000-0000-4000-8000-000000000001',
  b: '00000000-0000-4000-8000-000000000002',
  c: '00000000-0000-4000-8000-000000000003',
  d: '00000000-0000-4000-8000-000000000004',
});

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

function bundleFor(sourceContract, rows) {
  return buildMigrationBundle({
    sourceContract,
    targetContract: structuredClone(sourceContract),
    sourceRows: new Map(Object.entries(rows)),
    exportedAt: '2026-09-04T00:00:00.000Z',
  });
}

function reconcile(sourceContract, rows, options = {}) {
  return reconcileMigrationRows({
    bundle: bundleFor(sourceContract, rows),
    sourceContract,
    ...options,
  });
}

test('missing parents are quarantined with a hashed selector and cascade to children', () => {
  const contract = [
    table('tenants', [column('id', 'UUID')]),
    table('groups', [
      column('id', 'UUID'),
      column('tenant_id', 'UUID', { referencesTable: 'tenants' }),
    ]),
    table('group_members', [
      column('id', 'UUID'),
      column('group_id', 'UUID', { referencesTable: 'groups' }),
      column('user_id', 'UUID', { referencesTable: 'users' }),
    ]),
    table('users', [column('id', 'UUID')]),
  ];
  const { acceptedTables, report } = reconcile(contract, {
    tenants: [],
    groups: [{ id: IDS.a, tenant_id: IDS.d }],
    users: [{ id: IDS.b }],
    group_members: [{ id: IDS.c, group_id: IDS.a, user_id: IDS.b }],
  });
  assert.deepEqual(
    report.quarantine.map((entry) => entry.reasonCode),
    [
      RECONCILIATION_REASON_CODES.missingParent,
      RECONCILIATION_REASON_CODES.missingParent,
    ],
  );
  assert.equal(acceptedTables.find((entry) => entry.name === 'groups').rows.length, 0);
  assert.equal(
    acceptedTables.find((entry) => entry.name === 'group_members').rows.length,
    0,
  );
  assert.ok(report.quarantine.every((entry) => !JSON.stringify(entry).includes(IDS.a)));
});

test('duplicate natural keys and duplicate junction cardinality quarantine every collision', () => {
  const contract = [
    table('candidate_profiles', [
      column('id', 'UUID'),
      column('slug'),
      column('context'),
      column('profile_key'),
    ]),
    table('companies', [column('id', 'UUID')]),
    table('experience_companies', [
      column('id', 'UUID'),
      column('experience_id'),
      column('company_id'),
    ]),
    table('experiences', [column('id', 'UUID')]),
  ];
  const { report } = reconcile(contract, {
    candidate_profiles: [
      { id: IDS.a, slug: 'one', context: 'x', profile_key: 'same' },
      { id: IDS.b, slug: 'two', context: 'x', profile_key: 'same' },
    ],
    companies: [{ id: IDS.a }],
    experiences: [{ id: IDS.b }],
    experience_companies: [
      { id: IDS.c, experience_id: IDS.b, company_id: IDS.a },
      { id: IDS.d, experience_id: IDS.b, company_id: IDS.a },
    ],
  });
  assert.equal(
    report.quarantine.filter(
      (entry) =>
        entry.reasonCode === RECONCILIATION_REASON_CODES.duplicateNaturalKey,
    ).length,
    2,
  );
  assert.equal(
    report.quarantine.filter(
      (entry) =>
        entry.reasonCode === RECONCILIATION_REASON_CODES.junctionCardinality,
    ).length,
    2,
  );
});

test('malformed UUIDs and unqualified persisted STI values are quarantined', () => {
  const contract = [
    table('tenants', [
      column('id', 'UUID'),
      column('_meta_type'),
      column('parent_tenant_id', 'UUID', {
        notNull: false,
        referencesTable: 'tenants',
      }),
    ]),
  ];
  const { report } = reconcile(contract, {
    tenants: [
      { id: 'not-a-uuid', _meta_type: 'Tenant', parent_tenant_id: null },
    ],
  });
  assert.deepEqual(
    new Set(report.quarantine.map((entry) => entry.reasonCode)),
    new Set([
      RECONCILIATION_REASON_CODES.malformedUuid,
      RECONCILIATION_REASON_CODES.invalidQualifiedType,
    ]),
  );
  assert.equal(report.counts.rejected, 1);
});

test('the full canonical PostgreSQL UUID domain is accepted', () => {
  const contract = [table('tenants', [column('id', 'UUID')])];
  const { acceptedTables, report } = reconcile(contract, {
    tenants: [{ id: '00000000-0000-0000-0000-000000000000' }],
  });

  assert.equal(acceptedTables[0].rows.length, 1);
  assert.equal(report.counts.rejected, 0);
});

test('nullable empty references are deterministically repaired to null', () => {
  const contract = [
    table('places', [
      column('id', 'UUID'),
      column('parent_id', 'UUID', {
        notNull: false,
        referencesTable: 'places',
      }),
    ]),
  ];
  const { acceptedTables, report } = reconcile(contract, {
    places: [{ id: IDS.a, parent_id: '' }],
  });
  assert.equal(acceptedTables[0].rows[0].values.parent_id, null);
  assert.equal(report.counts.repaired, 1);
  assert.equal(report.repairs[0].reasonCode, 'EMPTY_REFERENCE_TO_NULL');
});

test('cross-tenant relationships are quarantined', () => {
  const contract = [
    table('profiles', [column('id', 'UUID'), column('tenant_id', 'UUID')]),
    table('audit_logs', [
      column('id', 'UUID'),
      column('tenant_id', 'UUID'),
      column('profile_id', 'UUID', { referencesTable: 'profiles' }),
    ]),
  ];
  const { report } = reconcile(contract, {
    profiles: [{ id: IDS.a, tenant_id: IDS.b }],
    audit_logs: [{ id: IDS.c, tenant_id: IDS.d, profile_id: IDS.a }],
  });
  assert.equal(
    report.quarantine[0].reasonCode,
    RECONCILIATION_REASON_CODES.tenantMismatch,
  );
});

test('self-reference cycles are quarantined instead of blocking bundle export', () => {
  const contract = [
    table('tenants', [
      column('id', 'UUID'),
      column('parent_tenant_id', 'UUID', {
        notNull: false,
        referencesTable: 'tenants',
      }),
    ]),
  ];
  const { report } = reconcile(contract, {
    tenants: [
      { id: IDS.a, parent_tenant_id: IDS.b },
      { id: IDS.b, parent_tenant_id: IDS.a },
    ],
  });
  assert.equal(
    report.quarantine.filter(
      (entry) => entry.reasonCode === RECONCILIATION_REASON_CODES.referenceCycle,
    ).length,
    2,
  );
});

test('reports are deterministic, secret-safe, and preserve source/target checksums', () => {
  const contract = [
    table('candidate_answers', [
      column('id', 'UUID'),
      column('slug'),
      column('context'),
      column('profile_key'),
      column('label_key'),
      column('value'),
    ]),
  ];
  const input = {
    candidate_answers: [
      {
        id: IDS.a,
        slug: 'answer',
        context: 'private-marker-context',
        profile_key: 'owner',
        label_key: 'question',
        value: 'private-marker-answer',
      },
    ],
  };
  const first = reconcile(contract, input, { strictNativeTypes: true }).report;
  const second = reconcile(contract, input, { strictNativeTypes: true }).report;
  assert.equal(first.reportDigest, second.reportDigest);
  assert.equal(first.assets.status, 'pending');
  const final = finalizeReconciliationReport(first, [
    {
      name: 'candidate_answers',
      inserted: 1,
      skipped: 0,
      updated: 0,
      targetChecksum: 'a'.repeat(64),
    },
  ]);
  assert.equal(final.tables[0].sourceChecksum.length, 64);
  assert.equal(final.tables[0].targetChecksum, 'a'.repeat(64));
  assert.equal(final.counts.imported, 1);
  assert.doesNotMatch(JSON.stringify(final), /private-marker|00000000-0000/);
});

test('stable-ID collisions use hashed selectors and remain deterministic', () => {
  const contract = [table('tenants', [column('id', 'UUID')])];
  const bundle = bundleFor(contract, { tenants: [{ id: IDS.a }] });
  const first = reconcileMigrationRows({ bundle, sourceContract: contract }).report;
  recordStableIdCollision(first, {
    runId: bundle.runId,
    table: 'tenants',
    sourceId: IDS.a,
  });
  recordStableIdCollision(first, {
    runId: bundle.runId,
    table: 'tenants',
    sourceId: IDS.a,
  });
  assert.equal(first.collisions.length, 1);
  assert.equal(
    first.collisions[0].reasonCode,
    RECONCILIATION_REASON_CODES.stableIdCollision,
  );
  assert.doesNotMatch(JSON.stringify(first.collisions), /00000000-0000/);
});

test('asset reconciliation distinguishes missing bytes and checksum mismatch', () => {
  const a = 'a'.repeat(64);
  const b = 'b'.repeat(64);
  const c = 'c'.repeat(64);
  const assets = [
    { id: 'asset-b', sourceChecksum: a, targetChecksum: b },
    { id: 'asset-a', sourceChecksum: a, targetChecksum: null },
    { id: 'asset-c', sourceChecksum: c, targetChecksum: c },
  ];
  const first = reconcileAssetInventory({ runId: 'run', assets });
  const second = reconcileAssetInventory({
    runId: 'run',
    assets: [...assets].reverse(),
  });
  assert.equal(first.digest, second.digest);
  assert.equal(first.status, 'complete');
  assert.deepEqual(first.counts, { attempted: 3, verified: 1, rejected: 2 });
  assert.deepEqual(
    first.quarantine.map((entry) => entry.reasonCode),
    [
      RECONCILIATION_REASON_CODES.assetMissing,
      RECONCILIATION_REASON_CODES.assetChecksumMismatch,
    ],
  );
  assert.doesNotMatch(JSON.stringify(first), /asset-[abc]/);
});

test('asset digests bind hashed identity and canonical content checksums', () => {
  const first = reconcileAssetInventory({
    runId: 'run',
    assets: [
      {
        id: 'private-asset',
        sourceChecksum: 'a'.repeat(64),
        targetChecksum: 'a'.repeat(64),
      },
    ],
  });
  const changed = reconcileAssetInventory({
    runId: 'run',
    assets: [
      {
        id: 'private-asset',
        sourceChecksum: 'b'.repeat(64),
        targetChecksum: 'b'.repeat(64),
      },
    ],
  });
  const invalid = reconcileAssetInventory({
    runId: 'run',
    assets: [
      {
        id: 'private-asset',
        sourceChecksum: 'not-a-checksum',
        targetChecksum: 'b'.repeat(64),
      },
    ],
  });

  assert.notEqual(first.digest, changed.digest);
  assert.equal(first.inventory[0].sourceChecksum, 'a'.repeat(64));
  assert.equal(
    invalid.quarantine[0].reasonCode,
    RECONCILIATION_REASON_CODES.assetInvalidChecksum,
  );
  assert.doesNotMatch(JSON.stringify(invalid), /private-asset|not-a-checksum/);
});

test('semantic audit principals and tenant ownership are reconciled', () => {
  const contract = [
    table('tenants', [column('id', 'UUID')]),
    table('profiles', [column('id', 'UUID'), column('tenant_id', 'UUID')]),
    table('users', [column('id', 'UUID'), column('profile_id', 'UUID')]),
    table('agent_runs', [
      column('id', 'UUID'),
      column('actor_profile_id', 'TEXT', { notNull: false }),
      column('initiated_by_user_id', 'TEXT', { notNull: false }),
      column('organization_profile_id', 'TEXT', { notNull: false }),
    ]),
  ];
  const { report } = reconcile(contract, {
    tenants: [],
    profiles: [{ id: IDS.a, tenant_id: IDS.d }],
    users: [{ id: IDS.b, profile_id: IDS.a }],
    agent_runs: [
      {
        id: IDS.c,
        actor_profile_id: IDS.a,
        initiated_by_user_id: IDS.b,
        organization_profile_id: IDS.d,
      },
    ],
  });

  assert.ok(
    report.quarantine.some(
      (entry) =>
        entry.table === 'profiles' &&
        entry.reasonCode === RECONCILIATION_REASON_CODES.missingParent,
    ),
  );
  assert.ok(
    report.quarantine.some(
      (entry) =>
        entry.table === 'agent_runs' &&
        entry.reasonCode === RECONCILIATION_REASON_CODES.missingParent,
    ),
  );
});

test('reports inventory intentional exclusions and known SMRT upgrade hazards', () => {
  assert.deepEqual(
    INTENTIONAL_MIGRATION_EXCLUSIONS.map((entry) => entry.item),
    [
      'sessions-and-tokens',
      'api-and-cli-credentials',
      'deployment-secrets',
      'live-worker-and-delivery-leases',
      'framework-migration-and-change-telemetry',
      'preview-and-idempotency-rows',
      'unreferenced-temporary-artifacts',
    ],
  );
  assert.deepEqual(
    SMRT_UPGRADE_HAZARDS.map((entry) => entry.code),
    [
      'DOMAIN_PACKAGE_QUALIFIER_RENAME',
      'PERSISTED_QUALIFIED_STI',
      'SOURCE_UUID_TO_TEXT_ID',
      'APPLICATION_SCHEDULE_TEXT_ID',
    ],
  );
});
