import type { DatabaseInterface } from '@happyvertical/sql';
import { migrateSmrtDatabase } from './db-common.js';
import {
  ensureTagIntegrityGuards,
  ensureRepairAuditTables,
  getTagIntegrityGuardStatus,
  inspectTagIntegrity,
  validateTagIntegrityGuards,
} from '../src/lib/server/tag-integrity.js';
import {
  ensureSourceCrawlOpportunityGuard,
  prepareSourceCrawlOpportunityReference,
  getSourceCrawlOpportunityGuardStatus,
  validateSourceCrawlOpportunityGuard,
} from '../src/lib/server/source-crawl-opportunity-integrity.js';
import {
  ensureCandidateAnswerNaturalKeyIndex,
  repairExistingCandidateAnswerNaturalKeyIndex,
} from '../src/lib/server/candidate-answer-schema.js';
import { ensureNativeAuthUniqueIndexes } from '../src/lib/server/auth-unique-indexes.js';
import { ensureOpportunityAnalysisSchema } from '../src/lib/server/opportunity-analysis-schema.js';
import { ensureOpportunityAnalysisMaintenanceSchema } from '../src/lib/server/opportunity-analysis-maintenance.js';
import { ensurePublicSearchSchema } from '../src/lib/server/public-search/schema.js';
import { ensureOpportunityListQueryIndexes } from '../src/lib/server/admin-opportunity-query.js';
import { ensureChangeFeedTableOnce } from '../src/lib/server/change-feed.js';
import { ensureSourceCrawlJobDedupe } from '../src/lib/server/source-crawl-job-schema.js';
import { ensureOpportunityIntelligenceJobDedupe } from '../src/lib/server/opportunity-intelligence-job-schema.js';
import { ensureAutoSubmitApplicationJobDedupe } from '../src/lib/server/auto-submit-application-job-schema.js';
import { ensureSourceCrawlAccountingSchema } from '../src/lib/server/source-crawl-accounting.js';
import { ensureOpportunityIntelligenceGovernanceSchema } from '../src/lib/server/opportunity-intelligence-governance.js';

async function restoreIntegrity(
  database: DatabaseInterface,
): Promise<unknown[]> {
  const failures: unknown[] = [];
  for (const restore of [
    ensureSourceCrawlOpportunityGuard,
    ensureTagIntegrityGuards,
  ]) {
    try {
      await restore(database);
    } catch (error) {
      failures.push(error);
    }
  }
  return failures;
}

/** Schema authority remains MigrationTracker; data ledger never wraps shell DDL. */
export async function prepareReleaseSchema(
  database: DatabaseInterface,
  checkSafety: () => Promise<void>,
): Promise<void> {
  for (const prepare of [
    repairExistingCandidateAnswerNaturalKeyIndex,
    prepareSourceCrawlOpportunityReference,
  ]) {
    await checkSafety();
    await prepare(database);
  }
  await checkSafety();
  let migrationFailure: unknown;
  try {
    await migrateSmrtDatabase(database, { maintenanceWindow: true });
  } catch (error) {
    migrationFailure = error;
  }
  // Restoration is deliberately allowed on failure: it closes the window in
  // which id-convergence dropped dependent referential integrity bridges.
  const failures = await restoreIntegrity(database);
  if (migrationFailure || failures.length)
    throw new AggregateError(
      [...(migrationFailure ? [migrationFailure] : []), ...failures],
      'Release schema or immediate integrity restoration failed.',
    );
  const prepares = [
    ensureCandidateAnswerNaturalKeyIndex,
    ensureNativeAuthUniqueIndexes,
    ensureOpportunityAnalysisSchema,
    ensureOpportunityAnalysisMaintenanceSchema,
    (db: DatabaseInterface) => ensurePublicSearchSchema(db, 'postgres'),
    ensureOpportunityListQueryIndexes,
    ensureChangeFeedTableOnce,
    ensureSourceCrawlJobDedupe,
    ensureOpportunityIntelligenceJobDedupe,
    ensureAutoSubmitApplicationJobDedupe,
    ensureSourceCrawlAccountingSchema,
    ensureRepairAuditTables,
    ensureOpportunityIntelligenceGovernanceSchema,
  ];
  for (const prepare of prepares) {
    await checkSafety();
    await prepare(database);
  }
}

export async function finalizeReleaseIntegrity(
  database: DatabaseInterface,
  checkSafety: () => Promise<void>,
): Promise<void> {
  const plan = await inspectTagIntegrity(database);
  if (
    plan.canonicalizations.length ||
    plan.orphanDeletes.length ||
    plan.unrepairable.length ||
    plan.collisions.length
  )
    throw new Error(
      'Legacy tag integrity needs explicit repair before activation.',
    );
  await checkSafety();
  await validateTagIntegrityGuards(database);
  await checkSafety();
  await validateSourceCrawlOpportunityGuard(database);
}

export async function verifyReleaseIntegrity(
  database: DatabaseInterface,
): Promise<void> {
  const tags = await getTagIntegrityGuardStatus(database);
  const sources = await getSourceCrawlOpportunityGuardStatus(database);
  if (
    tags.foreignKeysPresent !== tags.foreignKeysTotal ||
    tags.foreignKeysValidated !== tags.foreignKeysTotal ||
    tags.requiredColumnsNotNull !== tags.requiredColumnsTotal ||
    tags.uniqueIndexesPresent !== tags.uniqueIndexesTotal ||
    !sources.foreignKeyPresent ||
    !sources.foreignKeyValidated ||
    sources.totalDangling !== 0
  )
    throw new Error(
      'Release integrity verification failed; repair legacy integrity before activation.',
    );
}
