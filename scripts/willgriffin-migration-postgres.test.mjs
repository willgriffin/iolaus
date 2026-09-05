import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { test } from 'node:test';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { getDatabase } from '@happyvertical/sql';

import {
  buildMigrationBundle,
  PostgresMigrationStore,
  importMigrationBundle,
} from './willgriffin-migration.mjs';
import {
  syntheticBundle,
  syntheticContracts,
} from './synthetic-migration-rehearsal.mjs';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const evidencePath = resolve(
  repositoryRoot,
  '.omo/evidence/issue-32/migration-postgres-qualification.json',
);
const containerName = `iolaus-pg16-qualification-${process.pid}-${randomUUID()}`;
const databaseName = 'iolaus_rehearsal';
const postgresImage = 'postgres:16-alpine';

function docker(args, options = {}) {
  return execFileSync('docker', args, {
    cwd: repositoryRoot,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    ...options,
  }).trim();
}

function writeEvidence(value) {
  mkdirSync(dirname(evidencePath), { recursive: true, mode: 0o700 });
  writeFileSync(evidencePath, `${JSON.stringify(value, null, 2)}\n`, {
    mode: 0o600,
  });
}

async function waitForPostgres(containerId) {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    const health = docker(['inspect', '--format', '{{.State.Health.Status}}', containerId]);
    if (health === 'healthy') return;
    if (health === 'unhealthy' || health === 'exited') {
      throw new Error('Disposable PostgreSQL container became unhealthy.');
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 500));
  }
  throw new Error('Disposable PostgreSQL did not become ready within 60 seconds.');
}

function startPostgres() {
  try {
    docker(['version', '--format', '{{.Server.Version}}']);
  } catch {
    throw new Error('Docker prerequisite unavailable.');
  }
  const id = docker([
    'run',
    '--detach',
    '--rm',
    '--name',
    containerName,
    '--publish',
    '127.0.0.1::5432',
    '--env',
    'POSTGRES_HOST_AUTH_METHOD=trust',
    '--env',
    `POSTGRES_DB=${databaseName}`,
    '--health-cmd',
    `pg_isready --username=postgres --dbname=${databaseName}`,
    '--health-interval',
    '1s',
    '--health-timeout',
    '1s',
    '--health-retries',
    '60',
    postgresImage,
  ]);
  return id;
}

function stopPostgres(containerId) {
  if (!containerId) return;
  try {
    docker(['rm', '--force', containerId]);
  } catch {
    // The --rm container may already have exited. Cleanup is limited to this
    // uniquely named fixture container.
  }
}

function postgresPort(containerId) {
  const value = docker(['port', containerId, '5432/tcp']);
  const match = value.match(/127\.0\.0\.1:(\d+)/u);
  if (!match) throw new Error('Disposable PostgreSQL did not publish loopback port.');
  return match[1];
}

async function createTarget(db, targetContract) {
  for (const table of targetContract) {
    const columns = table.columns.map((field) => {
      const type = field.type === 'BOOLEAN' ? 'BOOLEAN' : 'TEXT';
      const primary = field.primaryKey ? ' PRIMARY KEY' : '';
      const nullable = field.notNull ? ' NOT NULL' : '';
      return `"${field.name}" ${type}${primary}${nullable}`;
    });
    await db.query(`CREATE TABLE "${table.name}" (${columns.join(', ')})`);
  }
}

async function resetDatabase(db, targetContract) {
  await db.query('DROP SCHEMA public CASCADE');
  await db.query('CREATE SCHEMA public');
  await createTarget(db, targetContract);
}

async function scalar(db, query, parameters = []) {
  const result = await db.query(query, parameters);
  return result.rows[0]?.value ?? result.rows[0]?.count ?? null;
}

async function migrationStatus(db, runId) {
  const result = await db.query(
    'SELECT status FROM _iolaus_migration_runs WHERE run_id = ?',
    [runId],
  );
  return result.rows[0]?.status ?? null;
}

async function rowCount(db, table, runId = null, tableName = null) {
  if (!runId || !tableName) {
    return Number(await scalar(db, `SELECT COUNT(*) AS count FROM "${table}"`));
  }
  return Number(
    await scalar(
      db,
      `SELECT COUNT(*) AS count FROM "${table}" WHERE run_id = ? AND table_name = ?`,
      [runId, tableName],
    ),
  );
}

class FinalizationDriftStore extends PostgresMigrationStore {
  async finalizeRun(input) {
    await this.db.query(
      'UPDATE "tenants" SET "name" = ? WHERE "id" = ?',
      ['synthetic-finalization-drift', 'tenant-a'],
    );
    return await super.finalizeRun(input);
  }
}

async function runQualification(db) {
  const contracts = syntheticContracts();
  const bundle = syntheticBundle(contracts);
  const version = await db.query('SHOW server_version');
  const serverVersion = String(version.rows[0]?.server_version || '');
  assert.match(serverVersion, /^16\./u);

  await resetDatabase(db, contracts.targetContract);
  const control = await importMigrationBundle({
    bundle,
    ...contracts,
    store: new PostgresMigrationStore(db),
    batchSize: 1,
  });
  const controlRerun = await importMigrationBundle({
    bundle,
    ...contracts,
    store: new PostgresMigrationStore(db),
    batchSize: 1,
  });
  const controlStatus = await migrationStatus(db, bundle.runId);
  assert.equal(controlStatus, 'complete');
  assert.equal(controlRerun.counts.attempted, 0);
  assert.equal(control.reconciliationDigest, controlRerun.reconciliationDigest);

  const rollbackSourceRows = new Map(
    bundle.tables.map((table) => [
      table.name,
      table.rows.map((row) => row.values),
    ]),
  );
  rollbackSourceRows.set('users', [
    {
      id: 'user-first',
      tenant_id: 'tenant-a',
      email: 'first@example.invalid',
    },
    {
      id: 'user-valid',
      tenant_id: 'tenant-a',
      email: 'valid@example.invalid',
    },
  ]);
  const rollbackBundle = buildMigrationBundle({
    sourceRows: rollbackSourceRows,
    sourceContract: contracts.sourceContract,
    targetContract: contracts.targetContract,
    exportedAt: bundle.exportedAt,
  });
  const rollbackUsers = rollbackBundle.tables.find(
    (table) => table.name === 'users',
  );
  assert.deepEqual(
    rollbackUsers.rows.map((row) => row.sourceId),
    ['user-first', 'user-valid'],
  );
  await resetDatabase(db, contracts.targetContract);
  await db.query(`
    CREATE FUNCTION iolaus_test_fail_user_insert() RETURNS trigger
    LANGUAGE plpgsql AS $$
    BEGIN
      IF NEW.id = 'user-valid' THEN
        RAISE EXCEPTION 'synthetic rollback trigger';
      END IF;
      RETURN NEW;
    END;
    $$
  `);
  await db.query(`
    CREATE TRIGGER iolaus_test_fail_user_insert
    BEFORE INSERT ON "users"
    FOR EACH ROW EXECUTE FUNCTION iolaus_test_fail_user_insert()
  `);
  await assert.rejects(
    importMigrationBundle({
      bundle: rollbackBundle,
      ...contracts,
      store: new PostgresMigrationStore(db),
      batchSize: 2,
    }),
    /Migration batch write failed for users/u,
  );
  await db.query('DROP TRIGGER iolaus_test_fail_user_insert ON "users"');
  await db.query('DROP FUNCTION iolaus_test_fail_user_insert()');
  const usersAfterFailure = await rowCount(db, 'users');
  const userLedgerRowsAfterFailure = await rowCount(
    db,
    '_iolaus_migration_rows',
    rollbackBundle.runId,
    'users',
  );
  const userCheckpointRowsAfterFailure = await rowCount(
    db,
    '_iolaus_migration_checkpoints',
    rollbackBundle.runId,
    'users',
  );
  const rollbackRunStatusAfterFailure = await migrationStatus(
    db,
    rollbackBundle.runId,
  );
  assert.equal(usersAfterFailure, 0);
  assert.equal(userLedgerRowsAfterFailure, 0);
  assert.equal(userCheckpointRowsAfterFailure, 0);
  assert.equal(rollbackRunStatusAfterFailure, 'running');
  const resumed = await importMigrationBundle({
    bundle: rollbackBundle,
    ...contracts,
    store: new PostgresMigrationStore(db),
    batchSize: 1,
  });
  const rollbackResumedStatus = await migrationStatus(db, rollbackBundle.runId);
  const usersAfterResume = await rowCount(db, 'users');
  assert.equal(rollbackResumedStatus, 'complete');
  assert.equal(usersAfterResume, 2);
  assert.equal(
    await rowCount(db, '_iolaus_migration_rows', rollbackBundle.runId, 'users'),
    2,
  );
  assert.ok(resumed.counts.attempted >= 2);

  await resetDatabase(db, contracts.targetContract);
  let fenceSession;
  try {
    await assert.rejects(
      importMigrationBundle({
        bundle,
        ...contracts,
        store: new PostgresMigrationStore(db),
        batchSize: 1,
        async onBatchCommitted({ table }) {
          if (table !== 'tenants' || fenceSession) return;
          fenceSession = await db.acquireSession();
          await fenceSession.query(
            'UPDATE _iolaus_migration_leases SET holder = ?, run_id = ? WHERE lease_name = ?',
            ['synthetic-replacement', 'synthetic-replacement', 'willgriffin-logical-migration'],
          );
        },
      }),
      /Migration batch write failed for tenants/u,
    );
  } finally {
    try {
      await fenceSession?.query(
        'DELETE FROM _iolaus_migration_leases WHERE holder = ?',
        ['synthetic-replacement'],
      );
    } finally {
      await fenceSession?.release();
    }
  }
  const tenantsAfterFenceFailure = await rowCount(db, 'tenants');
  const fenceRunStatusAfterFailure = await migrationStatus(db, bundle.runId);
  assert.equal(tenantsAfterFenceFailure, 1);
  assert.equal(fenceRunStatusAfterFailure, 'running');
  const fenceResumed = await importMigrationBundle({
    bundle,
    ...contracts,
    store: new PostgresMigrationStore(db),
    batchSize: 1,
  });
  const fenceResumedStatus = await migrationStatus(db, bundle.runId);
  assert.equal(fenceResumedStatus, 'complete');
  assert.equal(fenceResumed.reconciliationDigest, control.reconciliationDigest);

  await resetDatabase(db, contracts.targetContract);
  await assert.rejects(
    importMigrationBundle({
      bundle,
      ...contracts,
      store: new FinalizationDriftStore(db),
      batchSize: 1,
    }),
    /Migration final reconciliation failed/u,
  );
  const finalizationRunStatusAfterFailure = await migrationStatus(
    db,
    bundle.runId,
  );
  assert.equal(finalizationRunStatusAfterFailure, 'running');

  return {
    serverVersion,
    control: {
      status: controlStatus,
      rerunAttempted: controlRerun.counts.attempted,
      stableReconciliation: control.reconciliationDigest === controlRerun.reconciliationDigest,
    },
    rollback: {
      status: 'rolled-back-and-resumed',
      usersAfterFailure,
      userLedgerRowsAfterFailure,
      userCheckpointRowsAfterFailure,
      runStatusAfterFailure: rollbackRunStatusAfterFailure,
      usersAfterResume,
      resumedStatus: rollbackResumedStatus,
      errorClass: 'sanitized-batch-failure',
    },
    leaseFence: {
      status: 'fenced-and-resumed',
      tenantsAfterFenceFailure,
      runStatusAfterFenceFailure: fenceRunStatusAfterFailure,
      resumedStatus: fenceResumedStatus,
      errorClass: 'sanitized-batch-failure',
    },
    finalizationFence: {
      status: 'rejected-drift',
      runStatusAfterFailure: finalizationRunStatusAfterFailure,
      errorClass: 'sanitized-final-reconciliation-failure',
    },
  };
}

test('real PostgreSQL 16 migration qualification uses only synthetic data', { timeout: 120_000 }, async () => {
  let containerId;
  let db;
  const startedAt = new Date().toISOString();
  const evidence = {
    schema: 'iolaus-migration-postgres-qualification:v1',
    status: 'failed',
    startedAt,
    image: postgresImage,
    database: databaseName,
    bind: '127.0.0.1 only',
    syntheticDataOnly: true,
    externalDatabaseUrlUsed: false,
    productionAccessPerformed: false,
    secretValuesIncluded: false,
  };
  try {
    containerId = startPostgres();
    await waitForPostgres(containerId);
    const port = postgresPort(containerId);
    evidence.portBound = 'loopback-ephemeral';
    db = await getDatabase({
      type: 'postgres',
      url: `postgresql://postgres@127.0.0.1:${port}/${databaseName}`,
      cache: false,
      connectionTimeoutMillis: 10_000,
    });
    evidence.cases = await runQualification(db);
    evidence.status = 'passed';
    evidence.completedAt = new Date().toISOString();
    writeEvidence(evidence);
  } catch (error) {
    evidence.failure =
      error instanceof Error && /Docker prerequisite unavailable/u.test(error.message)
        ? 'docker-prerequisite-unavailable'
        : 'qualification-failed';
    evidence.completedAt = new Date().toISOString();
    writeEvidence(evidence);
    throw error;
  } finally {
    try {
      await db?.close?.();
    } finally {
      stopPostgres(containerId);
    }
  }
});
