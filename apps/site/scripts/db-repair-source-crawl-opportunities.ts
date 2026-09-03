import { randomUUID } from 'node:crypto';
import { resolveDatabase } from '@happyvertical/smrt-core';
import { getDatabaseUrl } from '../src/lib/server/db.js';
import {
  applySourceCrawlOpportunityRepair,
  inspectSourceCrawlOpportunityOrphans,
} from '../src/lib/server/source-crawl-opportunity-integrity.js';
import {
  assertDisposableLocalDatabaseUrl,
  assertLocalSourceCrawlRestoreEvidence,
  assertProductionSourceCrawlRecoveryEvidence,
  parseFlagArgs,
  redactDatabaseUrl,
  verifyBackup,
} from './db-snapshot.js';

const USAGE = `Usage:
  pnpm --filter @willgriffin/iolaus-site db:repair-source-crawl-opportunities -- --limit 100 [--after-id <uuid>] [--json]
  pnpm --filter @willgriffin/iolaus-site db:repair-source-crawl-opportunities -- \
    --apply --target <local|production> --limit <1..500> [--after-id <uuid>] \
    --expected-plan-sha256 <sha256> --from <backup-dir> \
    --backup-sha256 <sha256> [--allow-production]

Inspection is read-only and is the default. Each plan is keyset-paginated and
bounded to at most 500 rows. Apply is transactional, idempotent for the exact
plan, archives each full pre-repair row (including raw_json), and requires an
exact plan fingerprint plus verified recovery evidence. It never creates or
changes an Opportunity or a user decision.`;

const { flags } = parseFlagArgs(process.argv.slice(2));
if (flags.help) {
  console.log(USAGE);
  process.exit(0);
}

const databaseUrl = stringFlag('databaseUrl') ?? getDatabaseUrl();
const db = await resolveDatabase(
  { type: 'postgres', url: databaseUrl },
  { dbid: `source-crawl-opportunity-integrity-${randomUUID()}` },
);
const afterId = stringFlag('afterId');
const limit = integerFlag('limit', 100);
const plan = await inspectSourceCrawlOpportunityOrphans(db, { afterId, limit });

if (flags.json) {
  console.log(JSON.stringify(plan, null, 2));
} else {
  console.log(
    `Source crawl opportunity repair plan: ${redactDatabaseUrl(databaseUrl)}`,
  );
  console.log(`Plan SHA-256: ${plan.fingerprint}`);
  console.log(`Selected rows: ${plan.rows.length}/${plan.totalDangling}`);
  console.log(`Has another bounded page: ${plan.hasMore ? 'yes' : 'no'}`);
  if (plan.rows.length > 0) {
    console.log(`Next cursor: ${plan.rows.at(-1)?.rowId ?? ''}`);
  }
}

if (!flags.apply) process.exit(0);
const target = targetFlag();
if (target === 'local') {
  assertDisposableLocalDatabaseUrl(databaseUrl, 'A --target local repair');
}
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
  assertProductionSourceCrawlRecoveryEvidence({
    backup,
    databaseUrl,
    expectedFingerprint,
  });
} else {
  await assertLocalSourceCrawlRestoreEvidence(db, {
    backupSha256: approvedBackupSha256,
    planSha256: expectedFingerprint,
  });
}

const result = await applySourceCrawlOpportunityRepair(db, {
  afterId,
  backupSha256: approvedBackupSha256,
  expectedFingerprint,
  limit,
});
console.log(JSON.stringify(result, null, 2));

function stringFlag(name: string): string | undefined {
  const value = flags[name];
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function integerFlag(name: string, fallback: number): number {
  const raw = stringFlag(name);
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value)) throw new Error(`--${name} must be an integer.`);
  return value;
}

function requiredFlag(name: string): string {
  const value = stringFlag(name);
  if (!value) {
    throw new Error(
      `--${name.replace(/[A-Z]/gu, (letter) => `-${letter.toLowerCase()}`)} is required with --apply.`,
    );
  }
  return value;
}

function targetFlag(): 'local' | 'production' {
  const value = requiredFlag('target');
  if (value === 'local' || value === 'production') return value;
  throw new Error('--target must be local or production.');
}
