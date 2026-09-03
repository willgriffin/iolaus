import { randomUUID } from 'node:crypto';
import { resolveDatabase } from '@happyvertical/smrt-core';
import { getDatabaseUrl } from '../src/lib/server/db.js';
import {
  applySourceCrawlItemQuarantine,
  inspectSourceCrawlItemQuarantine,
  type SourceCrawlItemQuarantinePlan,
} from '../src/lib/server/source-crawl-item-quarantine.js';
import {
  assertDisposableLocalDatabaseUrl,
  assertLocalSourceCrawlRestoreEvidence,
  assertProductionSourceCrawlRecoveryEvidence,
  parseFlagArgs,
  redactDatabaseUrl,
  verifyBackup,
} from './db-snapshot.js';

const USAGE = `Usage:
  pnpm --filter @willgriffin/iolaus-site db:quarantine-source-crawl-item -- \
    --crawl-id <exact-id> --item-id <exact-id> [--json]
  pnpm --filter @willgriffin/iolaus-site db:quarantine-source-crawl-item -- \
    --apply --target <local|production> --crawl-id <exact-id> \
    --item-id <exact-id> --reason <operator-reason> \
    --expected-plan-sha256 <sha256> --from <backup-dir> \
    --backup-sha256 <sha256> --recovery-plan-sha256 <sha256> \
    [--allow-production]

Inspection is read-only and is the default. Apply is bounded to the exact crawl
and item, transactional, and idempotent for the exact plan. It requires a
matching before-state fingerprint and verified recovery evidence, archives the
complete parent and item rows, and records failed_persistence without assigning
or inferring an Opportunity. Production additionally requires
--target production --allow-production.`;

const { flags } = parseFlagArgs(process.argv.slice(2));
if (flags.help) {
  console.log(USAGE);
  process.exit(0);
}

const crawlId = requiredExactFlag('crawlId');
const itemId = requiredExactFlag('itemId');
const databaseUrl = stringFlag('databaseUrl') ?? getDatabaseUrl();
const db = await resolveDatabase(
  { type: 'postgres', url: databaseUrl },
  { dbid: `source-crawl-item-quarantine-${randomUUID()}` },
);
const plan = await inspectSourceCrawlItemQuarantine(db, { crawlId, itemId });

if (flags.json) {
  console.log(JSON.stringify(publicPlan(plan), null, 2));
} else {
  console.log(
    `Source crawl item quarantine plan: ${redactDatabaseUrl(databaseUrl)}`,
  );
  console.log(`Crawl/item: ${plan.crawlId}/${plan.itemId}`);
  console.log(`Plan SHA-256: ${plan.fingerprint}`);
  console.log(`Eligible: ${plan.eligible ? 'yes' : 'no'}`);
  console.log(`Assessment: ${plan.reason}`);
}

if (!flags.apply) process.exit(0);
const target = targetFlag();
if (target === 'local') {
  assertDisposableLocalDatabaseUrl(databaseUrl, 'A --target local quarantine');
}
if (target === 'production' && !flags.allowProduction) {
  throw new Error('A production quarantine requires --allow-production.');
}

const expectedFingerprint = requiredFlag('expectedPlanSha256');
const backupPath = requiredFlag('from');
const approvedBackupSha256 = requiredFlag('backupSha256');
const recoveryPlanSha256 = requiredFlag('recoveryPlanSha256');
const reason = requiredFlag('reason');
const backup = await verifyBackup(backupPath);
if (backup.database.dumpSha256 !== approvedBackupSha256) {
  throw new Error(
    `Backup digest mismatch: approved ${approvedBackupSha256}, verified ${backup.database.dumpSha256}.`,
  );
}
if (target === 'production') {
  assertProductionSourceCrawlRecoveryEvidence({
    backup,
    databaseUrl,
    expectedFingerprint: recoveryPlanSha256,
  });
} else {
  await assertLocalSourceCrawlRestoreEvidence(db, {
    backupSha256: approvedBackupSha256,
    planSha256: recoveryPlanSha256,
  });
}

const result = await applySourceCrawlItemQuarantine(db, {
  backupSha256: approvedBackupSha256,
  crawlId,
  expectedFingerprint,
  itemId,
  reason,
});
console.log(JSON.stringify(result, null, 2));

function publicPlan(plan: SourceCrawlItemQuarantinePlan) {
  return {
    crawlId: plan.crawlId,
    eligible: plan.eligible,
    fingerprint: plan.fingerprint,
    itemId: plan.itemId,
    itemOutcome: plan.itemOutcome,
    itemStatus: plan.itemStatus,
    reason: plan.reason,
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
