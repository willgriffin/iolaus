#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { getDatabase } from '@happyvertical/sql';

import {
  LocalSourceAssets,
  LocalTargetAssets,
  PostgresAssetMetadataStore,
  buildAssetMigrationManifest,
  importAssetMigrationManifest,
} from './willgriffin-asset-migration.mjs';
import {
  PostgresMigrationStore,
  buildMigrationBundle,
  importMigrationBundle,
} from './willgriffin-migration.mjs';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const defaultEvidencePath = resolve(
  repositoryRoot,
  '.omo/evidence/issue-32/synthetic-rehearsal.json',
);
const defaultParityEvidencePath = resolve(
  repositoryRoot,
  '.omo/evidence/issue-32/deployed-parity-contract.json',
);

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

function column(name, type = 'TEXT', options = {}) {
  return {
    name,
    type,
    notNull: options.notNull ?? true,
    primaryKey: options.primaryKey ?? name === 'id',
    referencesTable: options.referencesTable ?? null,
    referencesColumn: options.referencesColumn ?? null,
  };
}

function table(name, columns) {
  return { name, columns };
}

export function syntheticContracts() {
  const sourceContract = [
    table('tenants', [column('id'), column('name')]),
    table('users', [
      column('id'),
      column('tenant_id', 'TEXT', {
        referencesTable: 'tenants',
        referencesColumn: 'id',
      }),
      column('email'),
    ]),
    table('resume_assets', [
      column('id'),
      column('pdf_path'),
      column('text_path'),
      column('is_published', 'BOOLEAN'),
      column('application_id'),
    ]),
  ];
  const targetContract = [
    ...structuredClone(sourceContract),
    table('data_surface_idempotency', [column('id')]),
    table('data_surface_preview_tokens', [column('id')]),
  ];
  return { sourceContract, targetContract };
}

export function syntheticBundle(contracts = syntheticContracts()) {
  return buildMigrationBundle({
    ...contracts,
    exportedAt: '2026-01-01T00:00:00.000Z',
    sourceRows: new Map([
      [
        'tenants',
        [
          { id: 'tenant-a', name: 'Synthetic A' },
          { id: 'tenant-b', name: 'Synthetic B' },
        ],
      ],
      [
        'users',
        [
          {
            id: 'user-valid',
            tenant_id: 'tenant-a',
            email: 'valid@example.invalid',
          },
          {
            id: 'user-orphan',
            tenant_id: 'tenant-missing',
            email: 'orphan@example.invalid',
          },
        ],
      ],
      [
        'resume_assets',
        [
          {
            id: 'resume-synthetic',
            pdf_path: 'resumes/synthetic.pdf',
            text_path: 'resumes/synthetic.txt',
            is_published: true,
            application_id: '',
          },
        ],
      ],
    ]),
  });
}

export function validateRehearsalDatabaseUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error('The rehearsal database URL is invalid.');
  }
  const database = decodeURIComponent(url.pathname.replace(/^\//u, ''));
  if (
    !['postgres:', 'postgresql:'].includes(url.protocol) ||
    !['127.0.0.1', 'localhost', '::1'].includes(url.hostname) ||
    !/(?:rehearsal|test)/iu.test(database) ||
    url.search ||
    url.hash
  ) {
    throw new Error(
      'The rehearsal database must be a loopback PostgreSQL database visibly named rehearsal or test without URL overrides.',
    );
  }
  return value;
}

function run(binary, args, options = {}) {
  const result = spawnSync(binary, args, {
    cwd: repositoryRoot,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    ...options,
  });
  if (result.status !== 0) {
    throw new Error(`Synthetic rehearsal helper failed: ${binary}.`);
  }
  return result;
}

function postgresBinDirectory() {
  const configured = process.env.IOLAUS_REHEARSAL_POSTGRES_BIN?.trim();
  if (configured) return resolve(configured);
  const result = run('pg_config', ['--bindir']);
  const value = result.stdout.trim();
  if (!value) throw new Error('pg_config returned no PostgreSQL binary path.');
  return value;
}

async function availablePort() {
  return await new Promise((resolvePort, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      server.close((error) =>
        error || port === 0 ? reject(error || new Error('No port.')) : resolvePort(port),
      );
    });
  });
}

async function provisionDisposablePostgres(root) {
  const bin = postgresBinDirectory();
  if (!existsSync(join(bin, 'postgres'))) {
    return await provisionDockerPostgres(root);
  }
  const data = join(root, 'postgres');
  const socket = join(root, 'socket');
  const log = join(root, 'postgres.log');
  const port = await availablePort();
  mkdirSync(socket, { recursive: true, mode: 0o700 });
  run(join(bin, 'initdb'), [
    '--pgdata',
    data,
    '--auth=trust',
    '--encoding=UTF8',
    '--no-locale',
    '--username=iolaus_rehearsal',
  ]);
  run(join(bin, 'pg_ctl'), [
    '--pgdata',
    data,
    '--log',
    log,
    '--options',
    `-F -p ${port} -h 127.0.0.1 -k ${socket}`,
    '--wait',
    'start',
  ]);
  const env = {
    ...process.env,
    PGHOST: '127.0.0.1',
    PGPORT: String(port),
    PGUSER: 'iolaus_rehearsal',
  };
  run(join(bin, 'createdb'), ['iolaus_rehearsal'], { env });
  return {
    url: `postgresql://iolaus_rehearsal@127.0.0.1:${port}/iolaus_rehearsal`,
    stop() {
      run(join(bin, 'pg_ctl'), [
        '--pgdata',
        data,
        '--wait',
        '--mode=fast',
        'stop',
      ]);
    },
  };
}

async function provisionDockerPostgres(root) {
  const image = 'postgres:16-alpine';
  const inspected = spawnSync('docker', ['image', 'inspect', image], {
    cwd: repositoryRoot,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (inspected.status !== 0) {
    throw new Error(
      'No local PostgreSQL server is installed and the pinned postgres:16-alpine fallback image is unavailable.',
    );
  }
  const port = await availablePort();
  const name = `iolaus-rehearsal-${process.pid}-${sha256(root).slice(0, 8)}`;
  run('docker', [
    'run',
    '--detach',
    '--rm',
    '--name',
    name,
    '--publish',
    `127.0.0.1:${port}:5432`,
    '--env',
    'POSTGRES_HOST_AUTH_METHOD=trust',
    '--env',
    'POSTGRES_USER=iolaus_rehearsal',
    '--env',
    'POSTGRES_DB=iolaus_rehearsal',
    image,
  ]);
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const ready = spawnSync(
      'docker',
      ['exec', name, 'pg_isready', '--username=iolaus_rehearsal'],
      {
        cwd: repositoryRoot,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    if (ready.status === 0) {
      return {
        url: `postgresql://iolaus_rehearsal@127.0.0.1:${port}/iolaus_rehearsal`,
        stop() {
          run('docker', ['stop', '--time=5', name]);
        },
      };
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 250));
  }
  run('docker', ['stop', '--time=5', name]);
  throw new Error('Disposable PostgreSQL did not become ready.');
}

async function createSyntheticTarget(db, targetContract) {
  for (const contract of targetContract) {
    const columns = contract.columns.map((field) => {
      const type = field.type === 'BOOLEAN' ? 'BOOLEAN' : 'TEXT';
      const primary = field.primaryKey ? ' PRIMARY KEY' : '';
      const nullable = field.notNull ? ' NOT NULL' : '';
      return `"${field.name}" ${type}${primary}${nullable}`;
    });
    await db.query(`CREATE TABLE "${contract.name}" (${columns.join(', ')})`);
  }
}

class InterruptOnceTargetAssets {
  constructor(target) {
    this.target = target;
    this.interrupted = false;
  }

  async exists(path) {
    return await this.target.exists(path);
  }

  async read(path, options) {
    return await this.target.read(path, options);
  }

  async write(path, contents) {
    if (!this.interrupted) {
      this.interrupted = true;
      throw new Error('synthetic-interruption');
    }
    return await this.target.write(path, contents);
  }
}

function countQuarantine(result) {
  return result.reconciliation.quarantine.length;
}

async function runLogicalRehearsal({ databaseUrl, root }) {
  const contracts = syntheticContracts();
  const bundle = syntheticBundle(contracts);
  const db = await getDatabase({ type: 'postgres', url: databaseUrl });
  try {
    await createSyntheticTarget(db, contracts.targetContract);
    const store = new PostgresMigrationStore(db);
    const dryRun = await importMigrationBundle({
      bundle,
      ...contracts,
      store,
      dryRun: true,
      batchSize: 1,
    });
    let committedBatches = 0;
    let interrupted = false;
    try {
      await importMigrationBundle({
        bundle,
        ...contracts,
        store,
        batchSize: 1,
        onBatchCommitted() {
          committedBatches += 1;
          if (committedBatches === 1) throw new Error('synthetic-interruption');
        },
      });
    } catch (error) {
      if (error?.message !== 'synthetic-interruption') throw error;
      interrupted = true;
    }
    if (!interrupted) throw new Error('Synthetic logical interruption did not fire.');
    const resumed = await importMigrationBundle({
      bundle,
      ...contracts,
      store,
      batchSize: 1,
    });
    const rerun = await importMigrationBundle({
      bundle,
      ...contracts,
      store,
      batchSize: 1,
    });
    if (
      dryRun.reconciliationDigest !== resumed.reconciliationDigest ||
      resumed.reconciliationDigest !== rerun.reconciliationDigest ||
      countQuarantine(dryRun) !== 1 ||
      countQuarantine(resumed) !== 1
    ) {
      throw new Error('Synthetic logical reconciliation was not deterministic.');
    }
    const sourceAssetsRoot = join(root, 'source-assets');
    const targetAssetsRoot = join(root, 'target-assets');
    const stateRoot = join(root, 'asset-state');
    mkdirSync(join(sourceAssetsRoot, 'resumes'), { recursive: true, mode: 0o700 });
    const pdf = Buffer.from('%PDF-1.4\nsynthetic rehearsal only\n');
    const text = Buffer.from('synthetic rehearsal only\n');
    writeFileSync(join(sourceAssetsRoot, 'resumes/synthetic.pdf'), pdf, {
      mode: 0o600,
    });
    writeFileSync(join(sourceAssetsRoot, 'resumes/synthetic.txt'), text, {
      mode: 0o600,
    });
    const sourceAssets = new LocalSourceAssets({
      sourceRoot: repositoryRoot,
      root: sourceAssetsRoot,
    });
    const targetAssets = new LocalTargetAssets(targetAssetsRoot);
    const manifest = await buildAssetMigrationManifest({
      migrationBundle: bundle,
      sourceAssets,
    });
    const metadataStore = new PostgresAssetMetadataStore(db);
    const interruptedAssets = await importAssetMigrationManifest({
      manifest,
      sourceAssets,
      targetAssets: new InterruptOnceTargetAssets(targetAssets),
      stateRoot,
      metadataStore,
    });
    const resumedAssets = await importAssetMigrationManifest({
      manifest,
      sourceAssets,
      targetAssets,
      stateRoot,
      metadataStore,
    });
    const rerunAssets = await importAssetMigrationManifest({
      manifest,
      sourceAssets,
      targetAssets,
      stateRoot,
      metadataStore,
    });
    if (
      interruptedAssets.status !== 'quarantined' ||
      resumedAssets.status !== 'complete' ||
      rerunAssets.status !== 'complete' ||
      resumedAssets.reconciliationDigest !== rerunAssets.reconciliationDigest ||
      resumedAssets.counts.rejected !== 0 ||
      rerunAssets.counts.copied !== 0
    ) {
      throw new Error('Synthetic asset resume or idempotency verification failed.');
    }
    return {
      bundle,
      logical: { dryRun, resumed, rerun, interrupted, committedBatches },
      assets: { manifest, interruptedAssets, resumedAssets, rerunAssets },
    };
  } finally {
    await db.close?.();
  }
}

function argumentValue(name, argv) {
  const index = argv.indexOf(name);
  if (index < 0) return undefined;
  const value = argv[index + 1];
  if (!value || value.startsWith('--')) throw new Error(`${name} requires a value.`);
  return value;
}

function gitRevision() {
  return run('git', ['rev-parse', 'HEAD']).stdout.trim();
}

export function candidateParityIsAdmissible(parsed, revision) {
  if (
    parsed?.status !== 'passed' ||
    parsed.revision !== revision ||
    parsed.syntheticDataOnly !== true ||
    parsed.productionAccessPerformed !== false ||
    parsed.secretValuesIncluded !== false
  ) {
    return false;
  }
  return (
    parsed.candidateImageTested !== true ||
    (['local-image-id', 'released-repository-digest'].includes(
      parsed.candidateImageProvenance?.binding,
    ) &&
      parsed.executionProvenance?.candidateImageScenarioIds?.includes(
        'generated-surfaces',
      ))
  );
}

function runParity(argv, evidencePath) {
  if (argv.includes('--skip-parity')) {
    return { status: 'skipped-by-explicit-operator-option', evidenceSha256: null };
  }
  const args = [
    resolve(repositoryRoot, 'scripts/deployed-parity.mjs'),
    '--evidence',
    evidencePath,
  ];
  for (const option of ['--image-ref', '--local-image-id']) {
    const value = argumentValue(option, argv);
    if (value) args.push(option, value);
  }
  run(process.execPath, args);
  const evidenceBytes = readFileSync(evidencePath);
  const parsed = JSON.parse(evidenceBytes);
  if (!candidateParityIsAdmissible(parsed, gitRevision())) {
    throw new Error('Candidate parity evidence is not admissible.');
  }
  return {
    status: 'passed',
    candidateImageTested: parsed.candidateImageTested,
    revision: parsed.revision,
    provenanceBinding: parsed.candidateImageProvenance?.binding ?? null,
    candidateImageScenarioIds:
      parsed.executionProvenance.candidateImageScenarioIds,
    evidenceSha256: sha256(evidenceBytes),
    inventorySha256: parsed.inventorySha256,
  };
}

export function syntheticRehearsalDisposition(parity) {
  const eligible =
    parity?.status === 'passed' && parity?.candidateImageTested === true;
  return {
    status: eligible ? 'passed' : 'partial',
    syntheticRehearsalExitEligible: eligible,
    productionRehearsalExitEligible: false,
  };
}

function writeEvidence(path, evidence) {
  const absolute = resolve(path);
  mkdirSync(dirname(absolute), { recursive: true, mode: 0o700 });
  const temporary = `${absolute}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(evidence, null, 2)}\n`, {
    encoding: 'utf8',
    mode: 0o600,
  });
  renameSync(temporary, absolute);
  return absolute;
}

export async function runSyntheticMigrationRehearsal({
  databaseUrl,
  root,
  argv = [],
  evidencePath = defaultEvidencePath,
  parityEvidencePath = defaultParityEvidencePath,
}) {
  const logical = await runLogicalRehearsal({
    databaseUrl: validateRehearsalDatabaseUrl(databaseUrl),
    root,
  });
  const parity = runParity(argv, parityEvidencePath);
  const disposition = syntheticRehearsalDisposition(parity);
  const evidence = {
    schema: 'iolaus-synthetic-migration-rehearsal:v1',
    ...disposition,
    revision: gitRevision(),
    syntheticDataOnly: true,
    productionAccessPerformed: false,
    externalInfrastructureChanged: false,
    secretValuesIncluded: false,
    database: {
      engine: 'postgresql',
      disposable: true,
      endpointIncluded: false,
    },
    logicalMigration: {
      dryRunStatus: logical.logical.dryRun.status,
      interruptionObserved: logical.logical.interrupted,
      committedBatchesBeforeInterruption: logical.logical.committedBatches,
      resumeStatus: logical.logical.resumed.status,
      rerunStatus: logical.logical.rerun.status,
      sourceFingerprint: logical.bundle.sourceFingerprint,
      reconciliationDigest: logical.logical.resumed.reconciliationDigest,
      reconciliationStableAcrossDryRunResumeRerun:
        logical.logical.dryRun.reconciliationDigest ===
          logical.logical.resumed.reconciliationDigest &&
        logical.logical.resumed.reconciliationDigest ===
          logical.logical.rerun.reconciliationDigest,
      counts: logical.logical.resumed.counts,
      rejectedRecords: countQuarantine(logical.logical.resumed),
    },
    assetMigration: {
      interruptionStatus: logical.assets.interruptedAssets.status,
      resumeStatus: logical.assets.resumedAssets.status,
      rerunStatus: logical.assets.rerunAssets.status,
      manifestDigest: logical.assets.manifest.manifestDigest,
      reconciliationDigest: logical.assets.resumedAssets.reconciliationDigest,
      reconciliationStableAcrossResumeRerun:
        logical.assets.resumedAssets.reconciliationDigest ===
        logical.assets.rerunAssets.reconciliationDigest,
      entries: logical.assets.manifest.entries.length,
      copiedOnResume: logical.assets.resumedAssets.counts.copied,
      copiedOnIdempotentRerun: logical.assets.rerunAssets.counts.copied,
      rejectedAfterResume: logical.assets.resumedAssets.counts.rejected,
    },
    candidateParity: parity,
    remainingProductionCheckpoint:
      'Owner approval and verified restorable production database and asset backups are still required.',
  };
  const evidenceSha256 = sha256(canonicalJson(evidence));
  const written = writeEvidence(evidencePath, { ...evidence, evidenceSha256 });
  return { evidence, evidencePath: written, evidenceSha256 };
}

async function main() {
  const argv = process.argv.slice(2);
  const evidencePath = argumentValue('--evidence', argv) ?? defaultEvidencePath;
  const parityEvidencePath =
    argumentValue('--parity-evidence', argv) ?? defaultParityEvidencePath;
  const root = mkdtempSync(join(tmpdir(), 'iolaus-synthetic-rehearsal-'));
  let postgres;
  try {
    postgres = await provisionDisposablePostgres(root);
    const result = await runSyntheticMigrationRehearsal({
      databaseUrl: postgres.url,
      root,
      argv,
      evidencePath,
      parityEvidencePath,
    });
    console.log(
      JSON.stringify({
        schema: result.evidence.schema,
        status: result.evidence.status,
        evidencePath: result.evidencePath,
        evidenceSha256: result.evidenceSha256,
        secretValuesIncluded: false,
      }),
    );
  } finally {
    postgres?.stop();
    rmSync(root, { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
