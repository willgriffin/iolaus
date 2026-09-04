import { execFile, spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import {
  createReadStream,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import {
  access,
  chmod,
  cp,
  mkdir,
  readdir,
  readFile,
  stat,
  writeFile,
} from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type {
  FileInfo,
  FilesystemInterface,
  GetFilesystemOptions,
} from '@happyvertical/files';
import { getFilesystem } from '@happyvertical/files';
import { ObjectRegistry, resolveDatabase } from '@happyvertical/smrt-core';
import {
  getAppConfig,
  getConfiguredPublicOrigin,
} from '../src/lib/server/app-config.js';
import { getDatabaseUrl } from '../src/lib/server/db.js';
import {
  getResumeFilesConfig,
  PUBLISHED_RESUME_PDF_PATH,
} from '../src/lib/server/resume-files.js';
import { getIolausUserDataRoot } from '../src/lib/server/runtime-paths.js';
import type { SourceCrawlOpportunityPlanAttestation } from '../src/lib/server/source-crawl-opportunity-integrity.js';
import type { SourceCrawlParentRecoveryAttestation } from '../src/lib/server/source-crawl-parent-recovery.js';
import '../src/lib/server/smrt.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const SITE_ROOT = resolve(HERE, '..');
const REPO_ROOT = resolve(SITE_ROOT, '..', '..');
const BACKUP_KIND = 'iolaus-data-backup';
const LEGACY_BACKUP_KIND = 'iolaus.localhost-data-backup';
const SUPPORTED_BACKUP_KINDS = new Set([BACKUP_KIND, LEGACY_BACKUP_KIND]);
const BACKUP_VERSION = 1;
const DEFAULT_DUMP_FILE = 'database.dump';
const DEFAULT_FILES_DIR = 'files';
const DEFAULT_MANIFEST_FILE = 'manifest.json';
const INSTALLATION_ID_FILE = '.installation-id';

export interface BackupManifest {
  database: {
    archiveVerifiedAt?: string;
    dumpBytes?: number;
    dumpFile: string;
    dumpSha256?: string;
    name?: string;
    rowCounts: Record<string, number>;
    schemaCount: number;
    url: string;
  };
  files: {
    bytes: number;
    count: number;
    directory: string;
    exported: boolean;
    reason?: string;
    storageConfig: unknown;
  };
  gitSha: string | null;
  installationId?: string;
  kind: typeof BACKUP_KIND | typeof LEGACY_BACKUP_KIND;
  resume: ResumePublishStatus;
  recovery?: BackupRecoveryAttestation;
  source: 'current' | 'production';
  timestamp: string;
  version: typeof BACKUP_VERSION;
}

export interface BackupRecoveryAttestation {
  databaseName: string;
  dumpSha256: string;
  fullRestoreVerifiedAt: string;
  restoredRowCountsSha256: string;
  sourceCrawlOpportunityPlans: SourceCrawlOpportunityPlanAttestation[];
  sourceCrawlParentRecoveryPlans?: SourceCrawlParentRecoveryAttestation[];
  tagIntegrityPlanSha256: string;
}

export type RecoveryPlanKind =
  | 'source-crawl-opportunity'
  | 'source-crawl-parent'
  | 'tag-integrity';

type SmrtDatabase = Awaited<ReturnType<typeof resolveDatabase>>;

export interface VerifiedBackupManifest extends BackupManifest {
  database: BackupManifest['database'] & {
    archiveVerifiedAt: string;
    dumpBytes: number;
    dumpSha256: string;
  };
}

export interface ExportBackupOptions {
  allowLocal?: boolean;
  allowProduction?: boolean;
  backupRoot?: string;
  databaseUrl?: string;
  label?: string;
  prod?: boolean;
  skipFiles?: boolean;
}

export interface RestoreBackupOptions {
  allowInstallationRebind?: boolean;
  allowProduction?: boolean;
  backupPath: string;
  databaseUrl: string;
  skipDoctor?: boolean;
  skipFiles?: boolean;
  skipMigrate?: boolean;
}

export interface ResetLocalOptions
  extends Omit<RestoreBackupOptions, 'allowProduction'> {}

export interface ResumePublishStatus {
  error?: string;
  publishedAssetCount: number;
  publishedAssets: Array<{
    id: string;
    pdfBasename: string;
    pdfPath: string;
    publishedAt: string;
  }>;
  publishedAliasExists: boolean | null;
}

export interface FileCopySummary {
  bytes: number;
  count: number;
  exported: boolean;
  reason?: string;
}

type JsonRecord = Record<string, unknown>;

export function timestampForBackup(date = new Date()): string {
  return date.toISOString().replace(/[:.]/g, '-');
}

export function defaultBackupRoot(): string {
  if (process.env.IOLAUS_BACKUP_DIR) return process.env.IOLAUS_BACKUP_DIR;
  return join(installationStateRoot(), 'backups');
}

function installationStateRoot(): string {
  const config = getAppConfig();
  if (config.runtimeProfile === 'local') {
    return getIolausUserDataRoot();
  }
  const publicOrigin = getConfiguredPublicOrigin();
  if (!publicOrigin) {
    throw new Error(
      'Hosted backup identity requires a valid IOLAUS_PUBLIC_URL.',
    );
  }
  const originDigest = createHash('sha256')
    .update(publicOrigin)
    .digest('hex')
    .slice(0, 16);
  return join(homedir(), '.local', 'share', `${config.appId}-${originDigest}`);
}

export function getBackupInstallationId(): string {
  const config = getAppConfig();
  const stateRoot = installationStateRoot();
  const identityPath = join(stateRoot, INSTALLATION_ID_FILE);
  mkdirSync(stateRoot, { mode: 0o700, recursive: true });

  let identity: string;
  try {
    identity = readFileSync(identityPath, 'utf8').trim();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    identity = randomUUID();
    try {
      writeFileSync(identityPath, `${identity}\n`, {
        flag: 'wx',
        mode: 0o600,
      });
    } catch (writeError) {
      if ((writeError as NodeJS.ErrnoException).code !== 'EEXIST') {
        throw writeError;
      }
      identity = readFileSync(identityPath, 'utf8').trim();
    }
  }
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(
      identity,
    )
  ) {
    throw new Error(`Invalid installation identity: ${identityPath}`);
  }
  return `${config.appId}:${config.runtimeProfile}:${identity}`;
}

export function databaseNameFromUrl(databaseUrl: string): string {
  const url = new URL(databaseUrl);
  const database = decodeURIComponent(url.pathname.replace(/^\/+/u, ''));
  if (!database) throw new Error('Database URL must include a database name.');
  return database;
}

export function isLocalDatabaseUrl(databaseUrl: string): boolean {
  try {
    const url = new URL(databaseUrl);
    const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/gu, '');
    return (
      hostname === '' ||
      hostname === 'localhost' ||
      hostname === '127.0.0.1' ||
      hostname === '::1'
    );
  } catch {
    return false;
  }
}

export function assertDisposableLocalDatabaseUrl(
  databaseUrl: string,
  purpose: string,
): void {
  if (!isLocalDatabaseUrl(databaseUrl)) {
    throw new Error(`${purpose} requires a local database URL.`);
  }
  const databaseName = databaseNameFromUrl(databaseUrl);
  if (
    databaseName === 'postgres' ||
    databaseName.startsWith('template') ||
    !/(?:backup|issue|restore|test|verify)/u.test(databaseName)
  ) {
    throw new Error(
      `${purpose} database name must visibly identify disposable backup/issue/restore/test/verify work; received ${databaseName}.`,
    );
  }
}

export function redactDatabaseUrl(databaseUrl: string): string {
  try {
    const url = new URL(databaseUrl);
    if (url.username) url.username = '***';
    if (url.password) url.password = '***';
    return url.toString();
  } catch {
    return '[invalid database url]';
  }
}

export function assertCanExportDatabase(
  databaseUrl: string,
  options: { allowLocal?: boolean; allowProduction?: boolean; prod?: boolean },
): void {
  const local = isLocalDatabaseUrl(databaseUrl);
  if (options.prod && local && !options.allowLocal) {
    throw new Error(
      'Refusing to run production export against a local database. Pass --allow-local only when intentionally testing the production export path.',
    );
  }
  if (!options.prod && !local && !options.allowProduction) {
    throw new Error(
      'Refusing to export a non-local database through db:export. Use db:export-prod, or pass --allow-production intentionally.',
    );
  }
}

export function assertCanImportDatabase(
  databaseUrl: string,
  options: { allowProduction?: boolean },
): void {
  if (!isLocalDatabaseUrl(databaseUrl) && !options.allowProduction) {
    throw new Error(
      'Refusing to import into a non-local database without --allow-production.',
    );
  }
}

export function postgresEnvFromUrl(
  databaseUrl: string,
  databaseOverride?: string,
): Record<string, string> {
  const url = new URL(databaseUrl);
  if (url.protocol !== 'postgres:' && url.protocol !== 'postgresql:') {
    throw new Error(`Unsupported database URL protocol: ${url.protocol}`);
  }

  const env: Record<string, string> = {};
  const database = databaseOverride ?? databaseNameFromUrl(databaseUrl);
  env.PGDATABASE = database;
  if (url.hostname) env.PGHOST = url.hostname;
  if (url.port) env.PGPORT = url.port;
  if (url.username) env.PGUSER = decodeURIComponent(url.username);
  if (url.password) env.PGPASSWORD = decodeURIComponent(url.password);

  for (const [param, envName] of [
    ['sslmode', 'PGSSLMODE'],
    ['sslrootcert', 'PGSSLROOTCERT'],
    ['sslcert', 'PGSSLCERT'],
    ['sslkey', 'PGSSLKEY'],
  ] as const) {
    const value = url.searchParams.get(param);
    if (value) env[envName] = value;
  }

  return env;
}

export function redactFilesystemConfig(config: GetFilesystemOptions): unknown {
  return redactSecrets(config as unknown as JsonRecord);
}

function redactSecrets(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactSecrets);
  if (!value || typeof value !== 'object') return value;

  return Object.fromEntries(
    Object.entries(value as JsonRecord).map(([key, item]) => {
      const normalizedKey = key.toLowerCase();
      const secret =
        normalizedKey.includes('apikey') ||
        normalizedKey.includes('api_key') ||
        normalizedKey.includes('clientsecret') ||
        normalizedKey.includes('client_secret') ||
        normalizedKey.includes('credential') ||
        normalizedKey.includes('privatekey') ||
        normalizedKey.includes('private_key') ||
        normalizedKey.includes('secret') ||
        normalizedKey.includes('password') ||
        normalizedKey.includes('token') ||
        normalizedKey === 'serviceaccountkey' ||
        normalizedKey === 'accesskeyid';
      return [key, secret ? '[redacted]' : redactSecrets(item)];
    }),
  );
}

export function parseFlagArgs(args: string[]): {
  flags: Record<string, string | true>;
  positionals: string[];
} {
  const flags: Record<string, string | true> = {};
  const positionals: string[] = [];

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--') continue;
    if (!arg.startsWith('--')) {
      positionals.push(arg);
      continue;
    }

    const [rawKey, inlineValue] = arg.slice(2).split(/=(.*)/su, 2);
    const key = rawKey.replace(/-([a-z])/gu, (_match, letter: string) =>
      letter.toUpperCase(),
    );
    if (inlineValue !== undefined) {
      flags[key] = inlineValue;
      continue;
    }

    const next = args[index + 1];
    if (next && !next.startsWith('--')) {
      flags[key] = next;
      index += 1;
    } else {
      flags[key] = true;
    }
  }

  return { flags, positionals };
}

export function sourceCrawlRecoveryPlanOptions(
  flags: Record<string, string | true>,
): { limit: number } {
  const limitValue = flags.sourceCrawlLimit;
  const limit =
    typeof limitValue === 'string' && limitValue.trim()
      ? Number(limitValue)
      : 100;
  if (!Number.isInteger(limit) || limit < 1 || limit > 500) {
    throw new Error('--source-crawl-limit must be an integer from 1 to 500.');
  }
  return { limit };
}

export function resolveExportDatabaseUrl(options: ExportBackupOptions): string {
  if (options.databaseUrl) return options.databaseUrl;
  if (options.prod) {
    const productionUrl = process.env.PRODUCTION_DATABASE_URL?.trim();
    if (!productionUrl) {
      throw new Error(
        'PRODUCTION_DATABASE_URL is required for db:export-prod.',
      );
    }
    return productionUrl;
  }
  return getDatabaseUrl();
}

export async function exportBackup(
  options: ExportBackupOptions = {},
): Promise<string> {
  const databaseUrl = resolveExportDatabaseUrl(options);
  assertCanExportDatabase(databaseUrl, options);

  const label = options.label ?? (options.prod ? 'prod' : 'current');
  const backupPath = resolve(
    options.backupRoot ?? defaultBackupRoot(),
    `${label}-${timestampForBackup()}`,
  );
  await mkdir(backupPath, { mode: 0o700, recursive: true });
  await chmod(backupPath, 0o700);

  const dumpPath = join(backupPath, DEFAULT_DUMP_FILE);
  await runPgDump(databaseUrl, dumpPath);
  const dump = await verifyDatabaseDump(dumpPath);

  const [rowCounts, gitSha, files, resume] = await Promise.all([
    getRowCounts(databaseUrl),
    getGitSha(),
    options.skipFiles
      ? Promise.resolve<FileCopySummary>({
          bytes: 0,
          count: 0,
          exported: false,
          reason: 'Skipped by --skip-files.',
        })
      : exportResumeFiles(join(backupPath, DEFAULT_FILES_DIR)),
    getResumePublishStatus(databaseUrl),
  ]);

  const manifest: BackupManifest = {
    database: {
      ...dump,
      dumpFile: DEFAULT_DUMP_FILE,
      name: databaseNameFromUrl(databaseUrl),
      rowCounts,
      schemaCount: Object.keys(ObjectRegistry.getAllSchemasAsDefinitions())
        .length,
      url: redactDatabaseUrl(databaseUrl),
    },
    files: {
      ...files,
      directory: DEFAULT_FILES_DIR,
      storageConfig: redactFilesystemConfig(getResumeFilesConfig()),
    },
    gitSha,
    installationId: getBackupInstallationId(),
    kind: BACKUP_KIND,
    resume,
    source: options.prod ? 'production' : 'current',
    timestamp: new Date().toISOString(),
    version: BACKUP_VERSION,
  };

  await writeFile(
    join(backupPath, DEFAULT_MANIFEST_FILE),
    `${JSON.stringify(manifest, null, 2)}\n`,
    { mode: 0o600 },
  );

  return backupPath;
}

export async function restoreBackup(
  options: RestoreBackupOptions,
): Promise<void> {
  const backupPath = resolve(options.backupPath);
  const manifest = await verifyBackup(backupPath, {
    allowInstallationRebind: options.allowInstallationRebind,
  });
  assertCanImportDatabase(options.databaseUrl, options);

  await runPgRestore(
    options.databaseUrl,
    join(backupPath, manifest.database.dumpFile),
  );

  if (!options.skipFiles) {
    await importResumeFiles(join(backupPath, manifest.files.directory));
  }

  if (!options.skipMigrate) {
    await runPnpmScript('db:migrate', { DATABASE_URL: options.databaseUrl });
  }

  if (!options.skipDoctor) {
    await runPnpmScript('db:doctor', { DATABASE_URL: options.databaseUrl });
  }
}

export async function resetLocalDatabaseFromBackup(
  options: ResetLocalOptions,
): Promise<void> {
  assertCanImportDatabase(options.databaseUrl, { allowProduction: false });
  await verifyBackup(options.backupPath, {
    allowInstallationRebind: options.allowInstallationRebind,
  });

  const databaseName = databaseNameFromUrl(options.databaseUrl);
  const maintenanceEnv = postgresEnvFromUrl(options.databaseUrl, 'postgres');
  await runCommand('dropdb', ['--if-exists', databaseName], {
    env: maintenanceEnv,
  });
  await runCommand('createdb', [databaseName], { env: maintenanceEnv });
  await restoreBackup(options);
}

export async function readBackupManifest(
  backupPath: string,
  options: { allowInstallationRebind?: boolean } = {},
): Promise<BackupManifest> {
  const manifestPath = join(resolve(backupPath), DEFAULT_MANIFEST_FILE);
  const manifest = JSON.parse(
    await readFile(manifestPath, 'utf8'),
  ) as BackupManifest;
  if (
    !SUPPORTED_BACKUP_KINDS.has(manifest.kind) ||
    manifest.version !== BACKUP_VERSION
  ) {
    throw new Error(`Unsupported backup manifest: ${manifestPath}`);
  }
  if (
    manifest.kind === BACKUP_KIND &&
    !options.allowInstallationRebind &&
    (!manifest.installationId ||
      manifest.installationId !== getBackupInstallationId())
  ) {
    throw new Error(
      'Backup belongs to a different installation. Use its original runtime location or pass --allow-installation-rebind for deliberate disaster recovery.',
    );
  }
  return manifest;
}

export async function verifyBackup(
  backupPath: string,
  options: { allowInstallationRebind?: boolean } = {},
): Promise<VerifiedBackupManifest> {
  const resolvedPath = resolve(backupPath);
  const manifest = await readBackupManifest(resolvedPath, options);
  const verified = await verifyDatabaseDump(
    join(resolvedPath, manifest.database.dumpFile),
  );
  if (
    manifest.database.dumpSha256 &&
    manifest.database.dumpSha256 !== verified.dumpSha256
  ) {
    throw new Error(
      `Backup checksum mismatch: expected ${manifest.database.dumpSha256}, found ${verified.dumpSha256}.`,
    );
  }
  if (
    manifest.recovery &&
    manifest.recovery.dumpSha256 !== verified.dumpSha256
  ) {
    throw new Error(
      `Recovery attestation digest mismatch: expected ${manifest.recovery.dumpSha256}, found ${verified.dumpSha256}.`,
    );
  }
  if (
    manifest.database.dumpBytes !== undefined &&
    manifest.database.dumpBytes !== verified.dumpBytes
  ) {
    throw new Error(
      `Backup size mismatch: expected ${manifest.database.dumpBytes}, found ${verified.dumpBytes}.`,
    );
  }
  return {
    ...manifest,
    database: { ...manifest.database, ...verified },
  };
}

export function assertProductionRecoveryEvidence(options: {
  backup: VerifiedBackupManifest;
  databaseUrl: string;
  expectedFingerprint: string;
  now?: Date;
  planKind?: RecoveryPlanKind;
}): void {
  const { backup, databaseUrl, expectedFingerprint } = options;
  if (backup.source !== 'production') {
    throw new Error('Production repair requires a production-source backup.');
  }
  const recovery = backup.recovery;
  if (!recovery) {
    throw new Error(
      'Production repair requires a full-restore recovery attestation from db:verify-backup.',
    );
  }
  const targetDatabaseName = databaseNameFromUrl(databaseUrl);
  if (recovery.databaseName !== targetDatabaseName) {
    throw new Error(
      `Recovery attestation is for database ${recovery.databaseName}; target is ${targetDatabaseName}.`,
    );
  }
  if (recovery.dumpSha256 !== backup.database.dumpSha256) {
    throw new Error(
      'Recovery attestation is not bound to the verified dump digest.',
    );
  }
  const planKind = options.planKind ?? 'tag-integrity';
  const attestedFingerprint =
    planKind === 'source-crawl-opportunity'
      ? recovery.sourceCrawlOpportunityPlans?.some(
          (plan) => plan.planSha256 === expectedFingerprint,
        )
        ? expectedFingerprint
        : undefined
      : planKind === 'source-crawl-parent'
        ? recovery.sourceCrawlParentRecoveryPlans?.some(
            (plan) => plan.planSha256 === expectedFingerprint,
          )
          ? expectedFingerprint
          : undefined
        : recovery.tagIntegrityPlanSha256;
  if (attestedFingerprint !== expectedFingerprint) {
    throw new Error(
      `Recovery attestation ${planKind} plan does not match the approved live plan.`,
    );
  }
  const backupTime = Date.parse(backup.timestamp);
  const restoreTime = Date.parse(recovery.fullRestoreVerifiedAt);
  const ageMs = (options.now ?? new Date()).getTime() - backupTime;
  if (
    !Number.isFinite(backupTime) ||
    !Number.isFinite(restoreTime) ||
    restoreTime < backupTime ||
    ageMs < 0 ||
    ageMs > 4 * 60 * 60 * 1000
  ) {
    throw new Error(
      'Production repair requires a backup less than four hours old with a subsequent full-restore attestation.',
    );
  }
}

export function assertProductionSourceCrawlRecoveryEvidence(
  options: Omit<
    Parameters<typeof assertProductionRecoveryEvidence>[0],
    'planKind'
  >,
): void {
  assertProductionRecoveryEvidence({
    ...options,
    planKind: 'source-crawl-opportunity',
  });
}

export function assertProductionSourceCrawlParentRecoveryEvidence(
  options: Omit<
    Parameters<typeof assertProductionRecoveryEvidence>[0],
    'planKind'
  >,
): void {
  assertProductionRecoveryEvidence({
    ...options,
    planKind: 'source-crawl-parent',
  });
}

export async function recordBackupRecoveryAttestation(
  backupPath: string,
  recovery: BackupRecoveryAttestation,
): Promise<VerifiedBackupManifest> {
  const resolvedPath = resolve(backupPath);
  const manifest = await verifyBackup(resolvedPath);
  await chmod(resolvedPath, 0o700);
  await chmod(join(resolvedPath, manifest.database.dumpFile), 0o600);
  if (recovery.dumpSha256 !== manifest.database.dumpSha256) {
    throw new Error(
      'Recovery attestation must match the verified dump digest.',
    );
  }
  const updated: BackupManifest = {
    ...manifest,
    database: {
      ...manifest.database,
      name:
        manifest.database.name ?? databaseNameFromUrl(manifest.database.url),
    },
    recovery,
  };
  await writeFile(
    join(resolvedPath, DEFAULT_MANIFEST_FILE),
    `${JSON.stringify(updated, null, 2)}\n`,
    { mode: 0o600 },
  );
  return await verifyBackup(resolvedPath);
}

export async function recordLocalRestoreEvidence(
  db: SmrtDatabase,
  evidence: {
    backupSha256: string;
    planSha256: string;
    sourceCrawlOpportunityPlans: SourceCrawlOpportunityPlanAttestation[];
    sourceCrawlParentRecoveryPlans?: SourceCrawlParentRecoveryAttestation[];
    verifiedAt: string;
  },
): Promise<void> {
  const runTransaction = db.transaction;
  if (!runTransaction) {
    throw new Error('Local restore evidence requires transaction support.');
  }
  await runTransaction.call(db, async (transaction) => {
    await transaction.query(`
      CREATE TABLE IF NOT EXISTS public.local_backup_restore_evidence (
        backup_sha256 TEXT PRIMARY KEY,
        plan_sha256 TEXT NOT NULL,
        verified_at TIMESTAMP NOT NULL
      )
    `);
    await transaction.query(
      `INSERT INTO public.local_backup_restore_evidence (
         backup_sha256, plan_sha256, verified_at
       ) VALUES (?, ?, ?)
       ON CONFLICT (backup_sha256)
       DO UPDATE SET plan_sha256 = EXCLUDED.plan_sha256,
                     verified_at = EXCLUDED.verified_at`,
      [evidence.backupSha256, evidence.planSha256, evidence.verifiedAt],
    );
    await transaction.query(`
      CREATE TABLE IF NOT EXISTS public.local_source_crawl_restore_evidence (
        backup_sha256 TEXT NOT NULL,
        plan_sha256 TEXT NOT NULL,
        after_id TEXT NOT NULL,
        batch_limit INTEGER NOT NULL,
        verified_at TIMESTAMP NOT NULL,
        PRIMARY KEY (backup_sha256, plan_sha256)
      )
    `);
    await transaction.query(
      `DELETE FROM public.local_source_crawl_restore_evidence
       WHERE backup_sha256 = ?`,
      [evidence.backupSha256],
    );
    for (const plan of evidence.sourceCrawlOpportunityPlans) {
      await transaction.query(
        `INSERT INTO public.local_source_crawl_restore_evidence (
           backup_sha256, plan_sha256, after_id, batch_limit, verified_at
         ) VALUES (?, ?, ?, ?, ?)`,
        [
          evidence.backupSha256,
          plan.planSha256,
          plan.afterId,
          plan.limit,
          evidence.verifiedAt,
        ],
      );
    }
    await transaction.query(`
      CREATE TABLE IF NOT EXISTS public.local_source_crawl_parent_restore_evidence (
        backup_sha256 TEXT NOT NULL,
        plan_sha256 TEXT NOT NULL,
        crawl_id TEXT NOT NULL,
        verified_at TIMESTAMP NOT NULL,
        PRIMARY KEY (backup_sha256, plan_sha256)
      )
    `);
    await transaction.query(
      `DELETE FROM public.local_source_crawl_parent_restore_evidence
       WHERE backup_sha256 = ?`,
      [evidence.backupSha256],
    );
    for (const plan of evidence.sourceCrawlParentRecoveryPlans ?? []) {
      await transaction.query(
        `INSERT INTO public.local_source_crawl_parent_restore_evidence (
           backup_sha256, plan_sha256, crawl_id, verified_at
         ) VALUES (?, ?, ?, ?)`,
        [
          evidence.backupSha256,
          plan.planSha256,
          plan.crawlId,
          evidence.verifiedAt,
        ],
      );
    }
  });
}

export async function assertLocalRestoreEvidence(
  db: SmrtDatabase,
  evidence: {
    backupSha256: string;
    planKind?: RecoveryPlanKind;
    planSha256: string;
  },
): Promise<void> {
  const evidenceTable =
    evidence.planKind === 'source-crawl-opportunity'
      ? 'local_source_crawl_restore_evidence'
      : evidence.planKind === 'source-crawl-parent'
        ? 'local_source_crawl_parent_restore_evidence'
        : 'local_backup_restore_evidence';
  const table = await db.query(
    `SELECT to_regclass('public.${evidenceTable}')::text AS table_name`,
  );
  if (!table.rows[0]?.table_name) {
    throw new Error(
      'Local repair requires restore evidence created by db:verify-backup.',
    );
  }
  const matching = await db.query(
    `SELECT 1 FROM public.${evidenceTable}
     WHERE backup_sha256 = ? AND plan_sha256 = ?
     LIMIT 1`,
    [evidence.backupSha256, evidence.planSha256],
  );
  if (matching.rows.length === 0) {
    throw new Error(
      'Local restore evidence does not match the approved backup and repair plan.',
    );
  }
}

export async function assertLocalSourceCrawlRestoreEvidence(
  db: SmrtDatabase,
  evidence: { backupSha256: string; planSha256: string },
): Promise<void> {
  await assertLocalRestoreEvidence(db, {
    ...evidence,
    planKind: 'source-crawl-opportunity',
  });
}

export async function assertLocalSourceCrawlParentRestoreEvidence(
  db: SmrtDatabase,
  evidence: { backupSha256: string; planSha256: string },
): Promise<void> {
  await assertLocalRestoreEvidence(db, {
    ...evidence,
    planKind: 'source-crawl-parent',
  });
}

export async function verifyDatabaseDump(dumpPath: string): Promise<{
  archiveVerifiedAt: string;
  dumpBytes: number;
  dumpSha256: string;
}> {
  await assertFileExists(dumpPath);
  await runCommand('pg_restore', ['--list', dumpPath], { stdio: 'ignore' });
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(dumpPath)) hash.update(chunk);
  return {
    archiveVerifiedAt: new Date().toISOString(),
    dumpBytes: (await stat(dumpPath)).size,
    dumpSha256: hash.digest('hex'),
  };
}

export async function runPgDump(
  databaseUrl: string,
  dumpPath: string,
): Promise<void> {
  await mkdir(dirname(dumpPath), { recursive: true });
  await runCommand(
    'pg_dump',
    ['--format=custom', '--no-owner', '--no-acl', '--file', dumpPath],
    {
      env: postgresEnvFromUrl(databaseUrl),
    },
  );
  await chmod(dumpPath, 0o600);
}

export async function runPgRestore(
  databaseUrl: string,
  dumpPath: string,
): Promise<void> {
  await assertFileExists(dumpPath);
  await runCommand(
    'pg_restore',
    [
      '--exit-on-error',
      '--clean',
      '--if-exists',
      '--no-owner',
      '--no-acl',
      '--dbname',
      databaseNameFromUrl(databaseUrl),
      dumpPath,
    ],
    { env: postgresEnvFromUrl(databaseUrl) },
  );
}

export async function getRowCounts(
  databaseUrl: string,
): Promise<Record<string, number>> {
  const db = await resolveDatabase(
    { type: 'postgres', url: databaseUrl },
    { dbid: `snapshot-${randomUUID()}` },
  );
  const rows = await db.query(
    "SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename",
  );
  const counts: Record<string, number> = {};
  for (const row of rows.rows) {
    const table = String(row.tablename ?? '');
    if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/u.test(table)) continue;
    const count = await db.query(
      `SELECT count(*)::int AS count FROM ${quoteIdentifier(table)}`,
    );
    counts[table] = Number(count.rows[0]?.count ?? 0);
  }
  return counts;
}

export async function getResumePublishStatus(
  databaseUrl: string,
): Promise<ResumePublishStatus> {
  try {
    const db = await resolveDatabase(
      { type: 'postgres', url: databaseUrl },
      { dbid: `resume-status-${randomUUID()}` },
    );
    if (!(await db.tableExists('resume_assets'))) {
      return {
        publishedAssetCount: 0,
        publishedAliasExists: null,
        publishedAssets: [],
      };
    }

    const rows = await db.query(
      `SELECT id, pdf_basename, pdf_path, published_at
       FROM resume_assets
       WHERE is_published = true
       ORDER BY published_at DESC NULLS LAST`,
    );
    let publishedAliasExists: boolean | null = null;
    try {
      const filesystem = await getFilesystem(getResumeFilesConfig());
      publishedAliasExists = await filesystem.exists(PUBLISHED_RESUME_PDF_PATH);
    } catch {
      publishedAliasExists = null;
    }

    return {
      publishedAssetCount: rows.rows.length,
      publishedAliasExists,
      publishedAssets: rows.rows.map((row) => ({
        id: String(row.id ?? ''),
        pdfBasename: String(row.pdf_basename ?? ''),
        pdfPath: String(row.pdf_path ?? ''),
        publishedAt: row.published_at
          ? new Date(String(row.published_at)).toISOString()
          : '',
      })),
    };
  } catch (error) {
    return {
      error: error instanceof Error ? error.message : String(error),
      publishedAssetCount: 0,
      publishedAliasExists: null,
      publishedAssets: [],
    };
  }
}

export async function exportResumeFiles(
  targetDir: string,
): Promise<FileCopySummary> {
  const config = getResumeFilesConfig();
  const localBasePath = localBasePathForConfig(config);
  if (localBasePath) {
    if (!(await exists(localBasePath))) {
      return {
        bytes: 0,
        count: 0,
        exported: false,
        reason: `Local resume file storage path does not exist: ${localBasePath}`,
      };
    }
    await cp(localBasePath, targetDir, { recursive: true });
    return { ...(await summarizeDirectory(targetDir)), exported: true };
  }

  const filesystem = await getFilesystem(config);
  await copyFilesystemToLocalDirectory(filesystem, targetDir);
  return { ...(await summarizeDirectory(targetDir)), exported: true };
}

export async function importResumeFiles(
  sourceDir: string,
): Promise<FileCopySummary> {
  if (!(await exists(sourceDir))) {
    return {
      bytes: 0,
      count: 0,
      exported: false,
      reason: `Backup has no file storage directory: ${sourceDir}`,
    };
  }

  const config = getResumeFilesConfig();
  const localBasePath = localBasePathForConfig(config);
  if (localBasePath) {
    await mkdir(localBasePath, { recursive: true });
    await cp(sourceDir, localBasePath, { recursive: true });
    return { ...(await summarizeDirectory(sourceDir)), exported: true };
  }

  const filesystem = await getFilesystem(config);
  for (const filePath of await walkFiles(sourceDir)) {
    const storagePath = normalizeStoragePath(relative(sourceDir, filePath));
    await filesystem.write(storagePath, await readFile(filePath), {
      createParents: true,
    });
  }
  return { ...(await summarizeDirectory(sourceDir)), exported: true };
}

export async function runPnpmScript(
  scriptName: string,
  env: Record<string, string> = {},
): Promise<void> {
  await runCommand(
    'pnpm',
    ['--filter', '@willgriffin/iolaus-site', scriptName],
    {
      cwd: REPO_ROOT,
      env,
    },
  );
}

export async function runCommand(
  command: string,
  args: string[],
  options: {
    cwd?: string;
    env?: Record<string, string>;
    stdio?: 'ignore' | 'inherit' | 'pipe';
  } = {},
): Promise<void> {
  await new Promise<void>((resolvePromise, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd ?? process.cwd(),
      env: { ...process.env, ...options.env },
      stdio: options.stdio ?? 'inherit',
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) {
        resolvePromise();
        return;
      }
      reject(new Error(`${command} exited with status ${code}`));
    });
  });
}

async function copyFilesystemToLocalDirectory(
  filesystem: FilesystemInterface,
  targetDir: string,
): Promise<void> {
  await mkdir(targetDir, { recursive: true });
  const entries = await filesystem.list('', {
    recursive: true,
    detailed: true,
  });
  for (const entry of entries.filter((item) => !item.isDirectory)) {
    const storagePath = storagePathForFileInfo(entry);
    const targetPath = join(targetDir, storagePath);
    await mkdir(dirname(targetPath), { recursive: true });
    const content = await filesystem.read(storagePath, { raw: true });
    await writeFile(
      targetPath,
      Buffer.isBuffer(content) ? content : Buffer.from(content),
    );
  }
}

function storagePathForFileInfo(entry: FileInfo): string {
  return normalizeStoragePath(entry.path || entry.name);
}

function normalizeStoragePath(path: string): string {
  return path
    .split(/[\\/]+/u)
    .filter(Boolean)
    .join('/');
}

function localBasePathForConfig(config: GetFilesystemOptions): string | null {
  if (config.type && config.type !== 'local') return null;
  const basePath = config.basePath;
  return basePath ? resolve(basePath) : resolve(process.cwd());
}

async function summarizeDirectory(
  path: string,
): Promise<{ bytes: number; count: number }> {
  if (!(await exists(path))) return { bytes: 0, count: 0 };
  let bytes = 0;
  let count = 0;
  for (const filePath of await walkFiles(path)) {
    const info = await stat(filePath);
    bytes += info.size;
    count += 1;
  }
  return { bytes, count };
}

async function walkFiles(root: string): Promise<string[]> {
  const entries = await readdir(root, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const entryPath = join(root, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await walkFiles(entryPath)));
    } else if (entry.isFile()) {
      files.push(entryPath);
    }
  }
  return files;
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function assertFileExists(path: string): Promise<void> {
  if (!(await exists(path))) throw new Error(`File does not exist: ${path}`);
}

async function getGitSha(): Promise<string | null> {
  try {
    return await new Promise<string>((resolvePromise, reject) => {
      execFile(
        'git',
        ['rev-parse', 'HEAD'],
        { cwd: REPO_ROOT },
        (error, stdout) => {
          if (error) {
            reject(error);
            return;
          }
          resolvePromise(stdout.trim());
        },
      );
    });
  } catch {
    return null;
  }
}

function quoteIdentifier(value: string): string {
  return `"${value.replace(/"/gu, '""')}"`;
}
