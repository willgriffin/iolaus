import { randomUUID } from 'node:crypto';
import { resolveDatabase } from '@happyvertical/smrt-core';
import { getDatabaseUrl } from '../src/lib/server/db.js';
import {
  applySourceCrawlParentRecovery,
  inspectSourceCrawlParentRecovery,
  type SourceCrawlParentRecoveryPlan,
} from '../src/lib/server/source-crawl-parent-recovery.js';
import {
  assertDisposableLocalDatabaseUrl,
  assertLocalSourceCrawlParentRestoreEvidence,
  assertProductionSourceCrawlParentRecoveryEvidence,
  parseFlagArgs,
  redactDatabaseUrl,
  verifyBackup,
} from './db-snapshot.js';

const USAGE = `Usage:
  pnpm --filter @willgriffin/iolaus-site db:recover-source-crawl-parent -- \\
    --crawl-id <exact-id> [--json]
  pnpm --filter @willgriffin/iolaus-site db:recover-source-crawl-parent -- \\
    --apply --target <local|production> --crawl-id <exact-id> \\
    --reason <operator-reason> --expected-plan-sha256 <sha256> \\
    --from <backup-dir> --backup-sha256 <sha256> \\
    --recovery-plan-sha256 <sha256> [--allow-production]

Inspection is read-only. Apply is bounded to one exact legacy crawl, requires a
separately attested parent-recovery plan from a verified full backup restore,
archives the complete parent/job/item before state, reconciles canonical
accounting, and records only a timed_out parent. Production additionally
requires --target production --allow-production.`;

const { flags } = parseFlagArgs(process.argv.slice(2));
if (flags.help) {
  console.log(USAGE);
  process.exit(0);
}

const crawlId = requiredExactFlag('crawlId');
const databaseUrl = stringFlag('databaseUrl') ?? getDatabaseUrl();
const db = await resolveDatabase(
  { type: 'postgres', url: databaseUrl },
  { dbid: `source-crawl-parent-recovery-${randomUUID()}` },
);
const plan = await inspectSourceCrawlParentRecovery(db, { crawlId });

if (flags.json) console.log(JSON.stringify(publicPlan(plan), null, 2));
else {
  console.log(`Source crawl parent recovery plan: ${redactDatabaseUrl(databaseUrl)}`);
  console.log(`Crawl: ${plan.crawlId}`);
  console.log(`Plan SHA-256: ${plan.fingerprint}`);
  console.log(`Eligible: ${plan.eligible ? 'yes' : 'no'}`);
  console.log(`Job/items: ${plan.jobPresent ? 'present' : 'absent'}/${plan.itemCount}`);
  console.log(`Assessment: ${plan.reason}`);
}

if (!flags.apply) process.exit(0);
const target = targetFlag();
if (target === 'local') {
  assertDisposableLocalDatabaseUrl(databaseUrl, 'A --target local parent recovery');
}
if (target === 'production' && !flags.allowProduction) {
  throw new Error('A production parent recovery requires --allow-production.');
}

const expectedFingerprint = requiredFlag('expectedPlanSha256');
const backupPath = requiredFlag('from');
const approvedBackupSha256 = requiredFlag('backupSha256');
const recoveryPlanSha256 = requiredFlag('recoveryPlanSha256');
const reason = requiredFlag('reason');
if (recoveryPlanSha256 !== expectedFingerprint) {
  throw new Error(
    'The separately attested parent recovery plan must match the approved live before-state plan.',
  );
}
const backup = await verifyBackup(backupPath);
if (backup.database.dumpSha256 !== approvedBackupSha256) {
  throw new Error(
    `Backup digest mismatch: approved ${approvedBackupSha256}, verified ${backup.database.dumpSha256}.`,
  );
}
if (target === 'production') {
  assertProductionSourceCrawlParentRecoveryEvidence({
    backup,
    databaseUrl,
    expectedFingerprint: recoveryPlanSha256,
  });
} else {
  await assertLocalSourceCrawlParentRestoreEvidence(db, {
    backupSha256: approvedBackupSha256,
    planSha256: recoveryPlanSha256,
  });
}

console.log(
  JSON.stringify(
    await applySourceCrawlParentRecovery(db, {
      backupSha256: approvedBackupSha256,
      crawlId,
      expectedFingerprint,
      reason,
    }),
    null,
    2,
  ),
);

function publicPlan(plan: SourceCrawlParentRecoveryPlan) {
  return {
    crawlId: plan.crawlId,
    eligible: plan.eligible,
    fingerprint: plan.fingerprint,
    itemCount: plan.itemCount,
    jobPresent: plan.jobPresent,
    reason: plan.reason,
    sourceId: plan.sourceId,
    version: plan.version,
  };
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

function requiredExactFlag(name: string): string {
  const value = flags[name];
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

function targetFlag(): 'local' | 'production' {
  const value = requiredFlag('target');
  if (value === 'local' || value === 'production') return value;
  throw new Error('--target must be local or production.');
}
