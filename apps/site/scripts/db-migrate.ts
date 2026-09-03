import {
  initializeSmrtCollections,
  isResumeAdminBackfillApplied,
  isResumeSourceBackfillApplied,
  isSmrtNativeBackfillApplied,
  migrateSmrtDatabase,
  recordResumeAdminBackfillApplied,
  recordResumeSourceBackfillApplied,
  recordSmrtNativeBackfillApplied,
  withSmrtDatabaseMigrationLock,
} from './db-common.js';
import { backfillSmrtNative, formatBackfillSummary } from './backfill-smrt-native.js';
import {
  backfillResumeAdmin,
  ensurePublishedCurrentResumeAssetFiles,
  formatResumeAdminBackfillSummary,
} from './backfill-resume-admin.js';
import {
  backfillResumeSource,
  formatResumeSourceBackfillSummary,
} from './backfill-resume-source.js';
import {
  formatLifecycleRemapSummary,
  remapLifecycleValues,
} from './remap-lifecycle-values.js';
import {
  backfillAchievementPlacement,
  formatAchievementPlacementBackfillSummary,
} from './backfill-achievement-placement.js';
import { syncAllSourceSchedules } from '../src/lib/server/source-schedules.js';
import {
  ensureTagIntegrityGuards,
  inspectTagIntegrity,
  validateTagIntegrityGuards,
} from '../src/lib/server/tag-integrity.js';
import { ensureOpportunityListQueryIndexes } from '../src/lib/server/admin-opportunity-query.js';
import { formatIntegrityTextBridgeReleases } from '../src/lib/server/integrity-text-bridge.js';
import {
  ensureCandidateAnswerNaturalKeyIndex,
  repairExistingCandidateAnswerNaturalKeyIndex,
} from '../src/lib/server/candidate-answer-schema.js';
import {
  ensureSourceCrawlOpportunityGuard,
  prepareSourceCrawlOpportunityReference,
  validateSourceCrawlOpportunityGuard,
} from '../src/lib/server/source-crawl-opportunity-integrity.js';
import { ensureChangeFeedTableOnce } from '../src/lib/server/change-feed.js';
import { ensureSourceCrawlAccountingSchema } from '../src/lib/server/source-crawl-accounting.js';
import { ensureSourceCrawlJobDedupe } from '../src/lib/server/source-crawl-job-schema.js';
import { ensureSourceProvenanceSchema } from '../src/lib/server/source-provenance.js';
import { backfillSourceProviders } from '../src/lib/server/source-provider.js';
import {
  backfillOpportunitySourceFingerprints,
  formatOpportunitySourceFingerprintBackfillSummary,
} from '../src/lib/server/opportunity-source-fingerprint-backfill.js';

/**
 * Rebuild the integrity guards the text-bridge release drops.
 *
 * Each guard is attempted independently -- they cover different tables, so one
 * that cannot be rebuilt must not stop the other from being tried -- and every
 * failure is collected and returned rather than thrown, so the caller decides
 * what a partial restoration means. On the success path it means stop; on the
 * migration-failure path it means log and let the original error surface.
 */
async function restoreIntegrityGuards(
  db: Parameters<typeof ensureTagIntegrityGuards>[0],
): Promise<Error[]> {
  const failures: Error[] = [];
  for (const restore of [
    ensureSourceCrawlOpportunityGuard,
    ensureTagIntegrityGuards,
  ]) {
    try {
      await restore(db);
    } catch (restoreFailure) {
      const error =
        restoreFailure instanceof Error
          ? restoreFailure
          : new Error(String(restoreFailure));
      error.message = `${restore.name}: ${error.message}`;
      failures.push(error);
    }
  }
  return failures;
}

const {
  achievementPlacementBackfill,
  backfill,
  changeFeedTable,
  opportunitySourceFingerprints,
  initialized,
  lifecycleRemap,
  migration,
  opportunityQueryIndexes,
  restoredResumeAssetFiles,
  resumeBackfill,
  resumeSourceBackfill,
  sourceSchedules,
  sourceProvenance,
  sourceProviders,
  sourceCrawlAccountingSchema,
  sourceCrawlJobDedupe,
  sourceCrawlOpportunityGuard,
  tagIntegrityGuards,
} = await withSmrtDatabaseMigrationLock(async (database) => {
  await repairExistingCandidateAnswerNaturalKeyIndex(database);
  await prepareSourceCrawlOpportunityReference(database);
  // `migrateSmrtDatabase` releases the integrity text bridge columns and their
  // dependent foreign keys before applying the schema statements, and the
  // guard passes far below are what rebuild them. Everything between those two
  // points -- backfills, index builds, resume storage -- is fallible, and this
  // script is what the production init container runs, so a throw in that
  // stretch would leave the database unguarded while older replicas keep
  // writing, until someone ran a *successful* migrate.
  //
  // Close the window instead of widening the recovery: rebuild the guards as
  // the first thing after the schema statements land, and on the failure path
  // too. Both are idempotent `ensure` passes, so the later ones that capture
  // the reported status stay exactly as they were.
  let migration: Awaited<ReturnType<typeof migrateSmrtDatabase>>;
  try {
    migration = await migrateSmrtDatabase(database);
  } catch (cause) {
    // Best-effort here: the migration error is the one worth raising, so a
    // guard that also refuses to rebuild is reported and not allowed to
    // replace it.
    for (const failure of await restoreIntegrityGuards(database)) {
      console.error(
        'Failed to restore an integrity guard after a failed migration:',
        failure,
      );
    }
    throw cause;
  }
  // On the success path a guard that did not come back is fatal. Continuing
  // would run every remaining backfill and index build against a database
  // still missing the referential guard this migration released, which is the
  // exact state the early restore exists to prevent.
  const restoreFailures = await restoreIntegrityGuards(migration.db);
  if (restoreFailures.length > 0) {
    throw new AggregateError(
      restoreFailures,
      'Integrity guards released for the SMRT id convergence could not be rebuilt; refusing to continue the migration.',
    );
  }
  await ensureCandidateAnswerNaturalKeyIndex(migration.db);
  const initialized = await initializeSmrtCollections(database);
  await ensureOpportunityListQueryIndexes(migration.db);
  const backfillAlreadyApplied = await isSmrtNativeBackfillApplied(migration.db);
  const backfill = backfillAlreadyApplied ? null : await backfillSmrtNative();
  if (backfill) await recordSmrtNativeBackfillApplied(migration.db);
  // Run the de-naming remap AFTER the SMRT-native backfill: that backfill derives
  // actor profiles from created_by/decision_by and special-cases the old `will`
  // value, so remapping `will`->`owner` first would mis-name profiles on a
  // first-time backfill.
  const lifecycleRemap = await remapLifecycleValues(migration.db);
  const resumeBackfillAlreadyApplied = await isResumeAdminBackfillApplied(migration.db);
  const resumeBackfill = resumeBackfillAlreadyApplied ? null : await backfillResumeAdmin();
  if (resumeBackfill) await recordResumeAdminBackfillApplied(migration.db);
  const restoredResumeAssetFiles = resumeBackfillAlreadyApplied
    ? await ensurePublishedCurrentResumeAssetFiles()
    : 0;
  const resumeSourceBackfillAlreadyApplied = await isResumeSourceBackfillApplied(
    migration.db,
  );
  const resumeSourceBackfill = resumeSourceBackfillAlreadyApplied
    ? null
    : await backfillResumeSource();
  if (resumeSourceBackfill) await recordResumeSourceBackfillApplied(migration.db);
  const achievementPlacementBackfill = await backfillAchievementPlacement(migration.db);
  const sourceProvenance = await ensureSourceProvenanceSchema(migration.db);
  const sourceProviders = await backfillSourceProviders(migration.db);
  const opportunitySourceFingerprints =
    await backfillOpportunitySourceFingerprints(migration.db);
  // The change feed has to exist before anything appends to it. Raw writers
  // bump with `appendChange`, which issues no DDL on purpose (issue #458): the
  // framework's `bumpChangeFeed` would ensure the table on a per-handle basis,
  // and a bump inside a transaction always gets a fresh handle, so the first
  // bump after a deploy or a feed-schema migration would have run DDL inside
  // the archive or reconciliation transaction. Creating it here, on the
  // long-lived migration handle, is what lets those paths only append.
  await ensureChangeFeedTableOnce(migration.db);
  await ensureSourceCrawlJobDedupe(migration.db);
  const sourceSchedules = await syncAllSourceSchedules({ db: migration.db });
  const sourceCrawlAccountingSchema =
    await ensureSourceCrawlAccountingSchema(migration.db);
  let sourceCrawlOpportunityGuard =
    await ensureSourceCrawlOpportunityGuard(migration.db);
  if (sourceCrawlOpportunityGuard.totalDangling === 0) {
    sourceCrawlOpportunityGuard =
      await validateSourceCrawlOpportunityGuard(migration.db);
  }
  let tagIntegrityGuards = await ensureTagIntegrityGuards(migration.db);
  const tagIntegrityPlan = await inspectTagIntegrity(migration.db);
  if (
    tagIntegrityPlan.canonicalizations.length === 0 &&
    tagIntegrityPlan.orphanDeletes.length === 0 &&
    tagIntegrityPlan.unrepairable.length === 0 &&
    tagIntegrityPlan.collisions.length === 0
  ) {
    tagIntegrityGuards = await validateTagIntegrityGuards(migration.db);
  }

  return {
    achievementPlacementBackfill,
    backfill,
    initialized,
    lifecycleRemap,
    migration,
    opportunityQueryIndexes: true,
    opportunitySourceFingerprints,
    restoredResumeAssetFiles,
    resumeBackfill,
    resumeSourceBackfill,
    sourceSchedules,
    sourceProvenance,
    sourceProviders,
    changeFeedTable: true,
    sourceCrawlAccountingSchema,
    sourceCrawlJobDedupe: true,
    sourceCrawlOpportunityGuard,
    tagIntegrityGuards,
  };
});

console.log(formatIntegrityTextBridgeReleases(migration.bridgeReleases));
if (migration.applied) {
  console.log(`Applied ${migration.statements.length} schema statements.`);
} else {
  console.log('Database schema is already up to date.');
}
if (opportunityQueryIndexes) {
  console.log('Ensured opportunity list query indexes.');
}

console.log(formatLifecycleRemapSummary(lifecycleRemap));
console.log(`Initialized ${initialized.length} SMRT collections.`);
for (const name of initialized) {
  console.log(`- ${name}`);
}
if (backfill) {
  console.log(formatBackfillSummary(backfill));
} else {
  console.log('SMRT-native employment backfill was already applied.');
}
if (resumeBackfill) {
  console.log(formatResumeAdminBackfillSummary(resumeBackfill));
} else {
  console.log('Resume admin backfill was already applied.');
}
if (restoredResumeAssetFiles > 0) {
  console.log(`Restored ${restoredResumeAssetFiles} published resume asset file set.`);
}
if (resumeSourceBackfill) {
  console.log(formatResumeSourceBackfillSummary(resumeSourceBackfill));
} else {
  console.log('Resume source backfill was already applied.');
}
console.log(
  formatAchievementPlacementBackfillSummary(achievementPlacementBackfill),
);
console.log(
  `Source provenance: ${sourceProvenance.promotedRoots} legacy roots promoted from direct crawl history, ${sourceProvenance.postingDerived} posting-derived, ${sourceProvenance.unknown} unknown/non-operable.`,
);
console.log(
  formatOpportunitySourceFingerprintBackfillSummary(
    opportunitySourceFingerprints,
  ),
);
console.log(
  `Source providers: ${sourceProviders.classified} roots classified from adapter declarations, ${sourceProviders.unknown} remain unknown${sourceProviders.truncated ? ', bounded backfill truncated' : ''}.`,
);
if (changeFeedTable) {
  console.log('Ensured the SMRT change-feed table and append function.');
}
if (sourceCrawlJobDedupe) {
  console.log('Source crawl jobs: active-job uniqueness enforced per source.');
}
console.log(
  `Synced ${sourceSchedules.total} source schedules (${sourceSchedules.enabled} active, ${sourceSchedules.disabled} inactive/ad hoc).`,
);
console.log(
  `Source crawl accounting schema: ${sourceCrawlAccountingSchema.requiredColumnsPresent}/${sourceCrawlAccountingSchema.requiredColumnsTotal} columns present, attempt index ${sourceCrawlAccountingSchema.attemptIndexPresent ? 'present' : 'missing'}, outcome constraint ${sourceCrawlAccountingSchema.outcomeConstraintPresent ? 'present' : 'missing'}.`,
);
console.log(
  `Source crawl opportunity guard: foreign key ${sourceCrawlOpportunityGuard.foreignKeyPresent ? 'present' : 'missing'} (${sourceCrawlOpportunityGuard.foreignKeyValidated ? 'validated' : 'legacy rows pending validation'}), ${sourceCrawlOpportunityGuard.totalDangling} dangling references.`,
);
console.log(
  `Tag integrity guards: ${tagIntegrityGuards.foreignKeysPresent}/${tagIntegrityGuards.foreignKeysTotal} foreign keys present (${tagIntegrityGuards.foreignKeysValidated} validated), ${tagIntegrityGuards.requiredColumnsNotNull}/${tagIntegrityGuards.requiredColumnsTotal} business-key columns required, ${tagIntegrityGuards.uniqueIndexesPresent}/${tagIntegrityGuards.uniqueIndexesTotal} unique indexes present.`,
);
