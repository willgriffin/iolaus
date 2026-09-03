import { createHash, randomUUID } from 'node:crypto';
import { resolveDatabase } from '@happyvertical/smrt-core';
import { inspectSourceCrawlOpportunityPlanAttestations } from '../src/lib/server/source-crawl-opportunity-integrity.js';
import { inspectSourceCrawlParentRecoveryAttestation } from '../src/lib/server/source-crawl-parent-recovery.js';
import { inspectTagIntegrity } from '../src/lib/server/tag-integrity.js';
import {
  assertDisposableLocalDatabaseUrl,
  databaseNameFromUrl,
  getRowCounts,
  parseFlagArgs,
  readBackupManifest,
  recordBackupRecoveryAttestation,
  recordLocalRestoreEvidence,
  redactDatabaseUrl,
  resetLocalDatabaseFromBackup,
  sourceCrawlRecoveryPlanOptions,
  verifyBackup,
} from './db-snapshot.js';

const USAGE = `Usage:
  pnpm --filter @willgriffin/iolaus-site db:verify-backup -- \
    --from <backup-dir> --database-url <isolated-local-url> --allow-reset-local \
    [--source-crawl-limit <1..500>] \
    [--source-crawl-parent-recovery-id <exact-crawl-id>]

Drops and recreates the explicitly named local database, fully restores every
archive payload with pg_restore --exit-on-error, then records a recovery
attestation (dump digest, row-count digest, tag-plan digest, source-crawl
opportunity-plan digests, and an optional exact parent-recovery plan digest) in
the backup manifest. Never point this command at a database containing work you
need.`;

const { flags } = parseFlagArgs(process.argv.slice(2));
if (flags.help) {
  console.log(USAGE);
  process.exit(0);
}

const backupPath = requiredFlag('from');
const databaseUrl = requiredFlag('databaseUrl');
const sourceCrawlPlanOptions = sourceCrawlRecoveryPlanOptions(flags);
const parentRecoveryCrawlId = optionalExactFlag(
  'sourceCrawlParentRecoveryId',
);
if (!flags.allowResetLocal) {
  throw new Error('Refusing to reset the verification database without --allow-reset-local.');
}
assertDisposableLocalDatabaseUrl(databaseUrl, 'Backup recovery verification');

const before = await verifyBackup(backupPath);
await resetLocalDatabaseFromBackup({
  backupPath,
  databaseUrl,
  skipDoctor: true,
  skipFiles: true,
  skipMigrate: true,
});
const rowCounts = await getRowCounts(databaseUrl);
if (Object.keys(before.database.rowCounts).length > 0) {
  const expected = stableJson(before.database.rowCounts);
  const actual = stableJson(rowCounts);
  if (expected !== actual) {
    throw new Error('Restored database row counts do not match the backup manifest.');
  }
}
const db = await resolveDatabase(
  { type: 'postgres', url: databaseUrl },
  { dbid: `backup-verify-${randomUUID()}` },
);
const tagPlan = await inspectTagIntegrity(db);
const sourceCrawlOpportunityPlans =
  await inspectSourceCrawlOpportunityPlanAttestations(
    db,
    sourceCrawlPlanOptions,
  );
const sourceCrawlParentRecoveryPlans = parentRecoveryCrawlId
  ? [
      await inspectSourceCrawlParentRecoveryAttestation(db, {
        crawlId: parentRecoveryCrawlId,
      }),
    ]
  : [];
const fullRestoreVerifiedAt = new Date().toISOString();
await recordLocalRestoreEvidence(db, {
  backupSha256: before.database.dumpSha256,
  planSha256: tagPlan.fingerprint,
  sourceCrawlOpportunityPlans,
  sourceCrawlParentRecoveryPlans,
  verifiedAt: fullRestoreVerifiedAt,
});
const manifest = await readBackupManifest(backupPath);
const sourceDatabaseName =
  manifest.database.name ?? databaseNameFromUrl(manifest.database.url);
const verified = await recordBackupRecoveryAttestation(backupPath, {
  databaseName: sourceDatabaseName,
  dumpSha256: before.database.dumpSha256,
  fullRestoreVerifiedAt,
  restoredRowCountsSha256: sha256(rowCounts),
  sourceCrawlOpportunityPlans,
  sourceCrawlParentRecoveryPlans,
  tagIntegrityPlanSha256: tagPlan.fingerprint,
});

console.log(`Verified full backup restore: ${redactDatabaseUrl(databaseUrl)}`);
console.log(`Dump SHA-256: ${verified.database.dumpSha256}`);
console.log(`Row-count SHA-256: ${verified.recovery?.restoredRowCountsSha256}`);
console.log(`Tag plan SHA-256: ${verified.recovery?.tagIntegrityPlanSha256}`);
console.log(
  `Source crawl opportunity plan attestations: ${verified.recovery?.sourceCrawlOpportunityPlans.length ?? 0}`,
);
console.log(
  `Source crawl parent recovery plan attestations: ${verified.recovery?.sourceCrawlParentRecoveryPlans?.length ?? 0}`,
);
console.log(
  `Source crawl opportunity batch limit: ${sourceCrawlPlanOptions.limit}`,
);

function sha256(value: unknown): string {
  return createHash('sha256').update(stableJson(value)).digest('hex');
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

function stringFlag(name: string): string | undefined {
  const value = flags[name];
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function requiredFlag(name: string): string {
  const value = stringFlag(name);
  if (!value) {
    throw new Error(
      `--${name.replace(/[A-Z]/gu, (letter) => `-${letter.toLowerCase()}`)} is required.`,
    );
  }
  return value;
}

function optionalExactFlag(name: string): string | undefined {
  const value = flags[name];
  if (value === undefined) return undefined;
  if (
    typeof value !== 'string' ||
    !value ||
    value !== value.trim() ||
    value.length > 200
  ) {
    throw new Error(
      `--${name.replace(/[A-Z]/gu, (letter) => `-${letter.toLowerCase()}`)} must be an exact non-empty id.`,
    );
  }
  return value;
}
