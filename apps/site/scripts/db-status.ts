import { getDatabaseUrl } from '../src/lib/server/db.js';
import { getSourceCrawlAccountingSchemaStatus } from '../src/lib/server/source-crawl-accounting.js';
import { getSourceCrawlJobDedupeStatus } from '../src/lib/server/source-crawl-job-schema.js';
import { getSourceCrawlOpportunityGuardStatus } from '../src/lib/server/source-crawl-opportunity-integrity.js';
import {
  getSourceProvenanceSchemaStatus,
  sourceProvenanceSchemaIsReady,
} from '../src/lib/server/source-provenance.js';
import {
  getSourceProviderSchemaStatus,
  sourceProviderSchemaIsReady,
} from '../src/lib/server/source-provider.js';
import { getTagIntegrityGuardStatus } from '../src/lib/server/tag-integrity.js';
import { getPendingSchemaStatements } from './db-common.js';

function redactDatabaseUrl(databaseUrl: string): string {
  try {
    const url = new URL(databaseUrl);
    if (url.username) url.username = '***';
    if (url.password) url.password = '***';
    return url.toString();
  } catch {
    return '<invalid DATABASE_URL>';
  }
}

const pending = await getPendingSchemaStatements();
const tagIntegrityGuards = await getTagIntegrityGuardStatus(pending.db);
const sourceCrawlOpportunityGuard = await getSourceCrawlOpportunityGuardStatus(
  pending.db,
);
const sourceCrawlAccountingSchema = await getSourceCrawlAccountingSchemaStatus(
  pending.db,
);
const sourceCrawlJobDedupe = await getSourceCrawlJobDedupeStatus(pending.db);
const sourceProvenance = await getSourceProvenanceSchemaStatus(pending.db);
const sourceProviders = await getSourceProviderSchemaStatus(pending.db);

console.log('Database:', redactDatabaseUrl(getDatabaseUrl()));
console.log(`SMRT schemas registered: ${pending.schemaCount}`);
console.log(`Pending schema statements: ${pending.statements.length}`);
console.log(
  `Tag integrity guards: ${tagIntegrityGuards.foreignKeysPresent}/${tagIntegrityGuards.foreignKeysTotal} foreign keys present (${tagIntegrityGuards.foreignKeysValidated} validated), ${tagIntegrityGuards.requiredColumnsNotNull}/${tagIntegrityGuards.requiredColumnsTotal} business-key columns required, ${tagIntegrityGuards.uniqueIndexesPresent}/${tagIntegrityGuards.uniqueIndexesTotal} unique indexes present.`,
);
console.log(
  `Source crawl accounting schema: ${sourceCrawlAccountingSchema.requiredColumnsPresent}/${sourceCrawlAccountingSchema.requiredColumnsTotal} columns present, attempt index ${sourceCrawlAccountingSchema.attemptIndexPresent ? 'present' : 'missing'}, outcome constraint ${sourceCrawlAccountingSchema.outcomeConstraintPresent ? 'present' : 'missing'}.`,
);
console.log(
  `Source crawl jobs: active-job unique index ${sourceCrawlJobDedupe.activeIndexPresent ? 'ready' : sourceCrawlJobDedupe.activeIndexNamed ? 'malformed or not ready' : 'missing'}.`,
);
console.log(
  `Source provenance: source role ${sourceProvenance.sourceRoleRequired ? 'required' : 'nullable'}, role check ${sourceProvenance.sourceRoleCheckPresent ? 'present' : 'missing'} (${sourceProvenance.sourceRoleCheckValidated ? 'validated' : 'not validated'}), parent foreign key ${sourceProvenance.parentForeignKeyPresent ? 'present' : 'missing'} (${sourceProvenance.parentForeignKeyValidated ? 'validated' : 'not validated'}), forward parent guard ${sourceProvenance.parentForwardTriggerPresent ? 'present' : 'missing'}, reverse parent guard ${sourceProvenance.parentReverseTriggerPresent ? 'present' : 'missing'}.`,
);
console.log(
  `Source providers: provider ${sourceProviders.providerRequired ? 'required' : 'nullable'}, adapter check ${sourceProviders.constraintPresent ? 'present' : 'missing'} (${sourceProviders.constraintValidated ? 'validated' : 'not validated'}), ${sourceProviders.invalidProviders} invalid values.`,
);
console.log(
  `Source crawl opportunity guard: foreign key ${sourceCrawlOpportunityGuard.foreignKeyPresent ? 'present' : 'missing'} (${sourceCrawlOpportunityGuard.foreignKeyValidated ? 'validated' : 'not validated'}), ${sourceCrawlOpportunityGuard.totalDangling} dangling references.`,
);

if (
  tagIntegrityGuards.foreignKeysPresent !==
    tagIntegrityGuards.foreignKeysTotal ||
  tagIntegrityGuards.foreignKeysValidated !==
    tagIntegrityGuards.foreignKeysTotal ||
  tagIntegrityGuards.requiredColumnsNotNull !==
    tagIntegrityGuards.requiredColumnsTotal ||
  tagIntegrityGuards.uniqueIndexesPresent !==
    tagIntegrityGuards.uniqueIndexesTotal
) {
  process.exitCode = 1;
}
if (!sourceCrawlJobDedupe.activeIndexPresent) {
  process.exitCode = 1;
}
if (!sourceProvenanceSchemaIsReady(sourceProvenance)) {
  process.exitCode = 1;
}
if (!sourceProviderSchemaIsReady(sourceProviders)) {
  process.exitCode = 1;
}
if (!sourceCrawlOpportunityGuard.foreignKeyPresent) {
  process.exitCode = 1;
}
if (
  sourceCrawlAccountingSchema.requiredColumnsPresent !==
    sourceCrawlAccountingSchema.requiredColumnsTotal ||
  !sourceCrawlAccountingSchema.attemptIndexPresent ||
  !sourceCrawlAccountingSchema.outcomeConstraintPresent
) {
  process.exitCode = 1;
}
