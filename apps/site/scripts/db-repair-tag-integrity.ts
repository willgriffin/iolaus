import { randomUUID } from 'node:crypto';
import { resolveDatabase } from '@happyvertical/smrt-core';
import { getDatabaseUrl } from '../src/lib/server/db.js';
import {
  applyTagIntegrityRepair,
  inspectTagIntegrity,
} from '../src/lib/server/tag-integrity.js';
import {
  assertDisposableLocalDatabaseUrl,
  assertLocalRestoreEvidence,
  assertProductionRecoveryEvidence,
  parseFlagArgs,
  redactDatabaseUrl,
  verifyBackup,
} from './db-snapshot.js';

const USAGE = `Usage:
  pnpm --filter @willgriffin/iolaus-site db:repair-tag-integrity
  pnpm --filter @willgriffin/iolaus-site db:repair-tag-integrity -- --json
  pnpm --filter @willgriffin/iolaus-site db:repair-tag-integrity -- \\
    --apply --target <local|production> --expected-plan-sha256 <sha256> \\
    --from <backup-dir> --backup-sha256 <sha256> [--allow-production]

Inspection is read-only and is the default. Apply is transactional and requires
an exact plan fingerprint plus a verified backup digest. Target intent is
mandatory because production can appear local through a tunnel. Production
also requires --allow-production and fresh full-restore recovery evidence.`;

const { flags } = parseFlagArgs(process.argv.slice(2));
if (flags.help) {
  console.log(USAGE);
  process.exit(0);
}

const databaseUrl = stringFlag('databaseUrl') ?? getDatabaseUrl();
const db = await resolveDatabase(
  { type: 'postgres', url: databaseUrl },
  { dbid: `tag-integrity-${randomUUID()}` },
);
const plan = await inspectTagIntegrity(db);

if (flags.json) {
  console.log(JSON.stringify(plan, null, 2));
} else {
  printPlan(plan, databaseUrl);
}

if (!flags.apply) process.exit(0);
const target = targetFlag();
if (target === 'local')
  assertDisposableLocalDatabaseUrl(databaseUrl, 'A --target local repair');
if (target === 'production' && !flags.allowProduction) {
  throw new Error('A production repair requires --allow-production.');
}
const expectedFingerprint = requiredFlag('expectedPlanSha256');
const backupPath = requiredFlag('from');
const approvedBackupSha256 = requiredFlag('backupSha256');
const backup = await verifyBackup(backupPath);
if (backup.database.dumpSha256 !== approvedBackupSha256) {
  throw new Error(
    `Backup digest mismatch: approved ${approvedBackupSha256}, verified ${backup.database.dumpSha256}.`,
  );
}
if (target === 'production') {
  assertProductionRecoveryEvidence({
    backup,
    databaseUrl,
    expectedFingerprint,
  });
} else {
  await assertLocalRestoreEvidence(db, {
    backupSha256: approvedBackupSha256,
    planSha256: expectedFingerprint,
  });
}

const result = await applyTagIntegrityRepair(db, {
  backupSha256: approvedBackupSha256,
  expectedFingerprint,
});
console.log(JSON.stringify(result, null, 2));

function printPlan(
  value: Awaited<ReturnType<typeof inspectTagIntegrity>>,
  url: string,
): void {
  console.log(`Tag integrity plan: ${redactDatabaseUrl(url)}`);
  console.log(`Plan SHA-256: ${value.fingerprint}`);
  console.log(`Canonical tag ID rewrites: ${value.canonicalizations.length}`);
  console.log(`Missing canonical tags to create: ${value.tagCreations.length}`);
  console.log(`Orphaned join rows to archive and delete: ${value.orphanDeletes.length}`);
  console.log(`Unrepairable rows: ${value.unrepairable.length}`);
  console.log(`Canonical collisions: ${value.collisions.length}`);
  for (const table of tableCounts(value.canonicalizations)) {
    console.log(`- ${table.table}: ${table.count} canonical rewrites`);
  }
  for (const table of tableCounts(value.orphanDeletes)) {
    console.log(`- ${table.table}: ${table.count} orphan deletions`);
  }
}

function tableCounts(rows: Array<{ table: string }>) {
  const counts = new Map<string, number>();
  for (const row of rows) counts.set(row.table, (counts.get(row.table) ?? 0) + 1);
  return [...counts.entries()]
    .map(([table, count]) => ({ count, table }))
    .sort((left, right) => left.table.localeCompare(right.table));
}

function stringFlag(name: string): string | undefined {
  const value = flags[name];
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function requiredFlag(name: string): string {
  const value = stringFlag(name);
  if (!value) throw new Error(`--${name.replace(/[A-Z]/gu, (letter) => `-${letter.toLowerCase()}`)} is required with --apply.`);
  return value;
}

function targetFlag(): 'local' | 'production' {
  const value = requiredFlag('target');
  if (value === 'local' || value === 'production') return value;
  throw new Error('--target must be local or production.');
}
