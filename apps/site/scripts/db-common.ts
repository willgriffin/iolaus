// MUST be first: hydrate dependency manifests before any @happyvertical model
// package is imported below, so their classes register with complete schemas
// under tsx (no build scanner). See manifest-preload.ts for the full rationale.
import '../src/lib/server/manifest-preload.js';
import {
  ObjectRegistry,
  generateSchemaDiff,
  getSQLFromDiff,
  hasActionableChanges,
  migratePostgresSystemTimestamps,
  resolveDatabase,
} from '@happyvertical/smrt-core';
import {
  getDDLStrategy,
  planForeignKeyCreation,
} from '@happyvertical/smrt-core/schema';
import {
  MigrationTracker,
  createMigrationDefinition,
  generateMigrationTimestamp,
} from '@happyvertical/smrt-core/migrations';
import { randomUUID } from 'node:crypto';
import {
  MembershipCollection,
  RoleCollection,
  SessionCollection,
  TenantCollection,
  UserCollection,
} from '@happyvertical/smrt-users';
import { PlaceCollection, PlaceTypeCollection } from '@happyvertical/smrt-places';
import {
  FactCollection,
  FactContentCollection,
  FactEvidenceCollection,
  FactSourceCollection,
  FactSubjectCollection,
  FactTagCollection,
} from '@happyvertical/smrt-facts';
import {
  OidcIdentityCollection,
  ProfileCollection,
  ProfileRelationshipCollection,
  ProfileRelationshipTypeCollection,
  ProfileTypeCollection,
} from '@happyvertical/smrt-profiles';
import { SmrtJobCollection, SmrtJobEventCollection } from '@happyvertical/smrt-jobs';
import { TagCollection } from '@happyvertical/smrt-tags';
import { adminResources } from '../src/lib/admin/resources.js';
import { getDbConfig, getSmrtOptions } from '../src/lib/server/db.js';
import { seedSystemRolesWithPermissions } from '../src/lib/server/role-permissions.js';
import { ensureOpportunityIntelligenceJobDedupe } from '../src/lib/server/opportunity-intelligence-job-schema.js';
import {
  ensureOpportunityIntelligenceControl,
  ensureOpportunityIntelligenceGovernanceSchema,
} from '../src/lib/server/opportunity-intelligence-governance.js';
import { ensureCanonicalResumeTailoringConfig } from '../src/lib/server/resume-tailoring-configs.js';
import { ensureSourceScheduleTable } from '../src/lib/server/source-schedules.js';
import { getCollection } from '../src/lib/server/smrt.js';
import { releaseIntegrityTextBridges } from '../src/lib/server/integrity-text-bridge.js';

export const smrtNativeBackfillVersion = '20260525_smrt_native_employment_backfill';
export const resumeAdminBackfillVersion = '20260525_resume_admin_backfill';
export const resumeSourceBackfillVersion = '20260526_resume_source_model_backfill';

type SmrtDatabase = Awaited<ReturnType<typeof resolveDatabase>>;

const smrtDatabaseMigrationLockId = '@willgriffin/iolaus-site:smrt-database-migration';
const smrtDatabaseMigrationLockTimeout = '120s';
const smrtDatabaseMigrationStatementTimeout = '125s';

function getStatementsFromDiff(diff: Awaited<ReturnType<typeof generateSchemaDiff>>): string[] {
  const statements: string[] = [];
  const strategy = getDDLStrategy('postgres');
  const tablePlan = planForeignKeyCreation(diff.added_tables, strategy.engine);

  for (const schema of tablePlan.schemas) {
    statements.push(strategy.generateCreateTable(schema));
    statements.push(...strategy.generateIndexes(schema));
    statements.push(...strategy.generateTriggers(schema));
  }

  statements.push(...tablePlan.deferredStatements);
  statements.push(...getSQLFromDiff(diff));
  return statements.filter((statement) => statement.trim().length > 0);
}

/**
 * Serialize complete startup schema work across deployment replicas.
 *
 * MigrationTracker deliberately runs PostgreSQL concurrent-index DDL outside
 * a transaction, so this uses the upstream SQL adapter's pinned session API
 * and a session advisory lock rather than a transaction-scoped lock. The
 * session is released in all cases, which releases the advisory lock even if
 * this process cannot explicitly unlock it.
 */
export async function withSmrtDatabaseMigrationLock<T>(
  work: (database: SmrtDatabase) => Promise<T>,
  db?: SmrtDatabase,
): Promise<T> {
  const database = db ?? (await resolveDatabase(getDbConfig()));
  if (typeof database.acquireSession !== 'function') {
    throw new Error(
      'SMRT database migration requires a PostgreSQL adapter with pinned-session support.',
    );
  }

  const session = await database.acquireSession();
  try {
    // `set_config(..., false)` applies to this pinned session only. Its bounded
    // settings govern advisory-lock acquisition; MigrationTracker retains its
    // own bounded transaction and concurrent-index execution settings.
    await session.query("SELECT set_config('lock_timeout', $1, false)", [
      smrtDatabaseMigrationLockTimeout,
    ]);
    await session.query("SELECT set_config('statement_timeout', $1, false)", [
      smrtDatabaseMigrationStatementTimeout,
    ]);
    await session.query('SELECT pg_advisory_lock(hashtext($1))', [
      smrtDatabaseMigrationLockId,
    ]);
    return await work(database);
  } finally {
    await session.release();
  }
}

/**
 * Bring legacy SMRT system timestamps forward before migration schema
 * inspection or collection bootstrap. The upstream migration is atomic and
 * idempotent, so calling it at both mutation entry points is safe. Production
 * was audited with a UTC PostgreSQL session before selecting this explicit
 * legacy timezone.
 */
export async function prepareSmrtDatabaseCompatibility(
  db?: SmrtDatabase,
): Promise<SmrtDatabase> {
  const database = db ?? (await resolveDatabase(getDbConfig()));
  await migratePostgresSystemTimestamps(database, { legacyTimezone: 'UTC' });
  return database;
}

export async function getPendingSchemaStatements(db?: SmrtDatabase) {
  const database = db ?? (await resolveDatabase(getDbConfig()));
  const schemas = ObjectRegistry.getAllSchemasAsDefinitions();
  const diff = await generateSchemaDiff(database, schemas);
  const statements = getStatementsFromDiff(diff);

  return {
    db: database,
    diff,
    schemaCount: Object.keys(schemas).length,
    statements,
    hasChanges: hasActionableChanges(diff),
  };
}

export async function migrateSmrtDatabase(db?: SmrtDatabase) {
  const database = await prepareSmrtDatabaseCompatibility(db);
  const pending = await getPendingSchemaStatements(database);
  if (!pending.hasChanges || pending.statements.length === 0) {
    return { ...pending, applied: false, bridgeReleases: [], results: [] };
  }

  // SMRT 0.44.0 converges legacy `text` id columns to `uuid` before it
  // provisions dependent foreign keys (smrt#2611). PostgreSQL refuses that
  // conversion while this application's own stored generated `text` bridge
  // column depends on the id column, so release the bridge first; the guards
  // that own it rebuild it after this migration, inside the same advisory lock.
  const bridgeReleases = await releaseIntegrityTextBridges(
    pending.db,
    pending.statements,
  );

  const tracker = new MigrationTracker({
    db: pending.db,
    useConcurrentIndexes: true,
  });
  const migration = createMigrationDefinition(
    `${generateMigrationTimestamp()}_smrt_schema_sync`,
    pending.statements,
    [],
    {
      description: 'Synchronize SMRT object schemas',
      packageName: '@willgriffin/iolaus-site',
      version: '0.1.0',
    },
  );
  const results = await tracker.applyAll([migration], {
    postgresSafe: true,
    reconcile: true,
  });

  const failed = results.find((result) => !result.success);
  if (failed) {
    throw failed.error instanceof Error
      ? failed.error
      : new Error(String(failed.error ?? `Migration ${failed.name} failed`));
  }

  return { ...pending, applied: true, bridgeReleases, results };
}

export async function initializeSmrtCollections(db?: SmrtDatabase): Promise<string[]> {
  await prepareSmrtDatabaseCompatibility(db);
  const options = getSmrtOptions();
  const initialized: string[] = [];

  await getCollection('CliAuthRequest');
  initialized.push('CliAuthRequest');

  // Data-surface action state. Neither object is an admin resource -- both are
  // deliberately absent from every generated surface -- so their tables only
  // exist if the migration asks for their collections explicitly.
  for (const className of [
    'DataSurfaceIdempotencyRecord',
    'DataSurfacePreviewToken',
  ]) {
    await getCollection(className);
    initialized.push(className);
  }

  for (const className of [
    'OpportunityIntelligenceControl',
    'OpportunityIntelligenceRequest',
    'OpportunityIntelligenceResult',
  ]) {
    await getCollection(className);
    initialized.push(className);
  }

  for (const resource of adminResources) {
    await getCollection(resource.className);
    initialized.push(resource.className);
  }

  const users = await UserCollection.create(options);
  const tenants = await TenantCollection.create(options);
  const memberships = await MembershipCollection.create(options);
  const sessions = await SessionCollection.create(options);
  const roles = await RoleCollection.create(options);
  const profiles = await ProfileCollection.create(options);
  const profileTypes = await ProfileTypeCollection.create(options);
  const profileRelationships = await ProfileRelationshipCollection.create(options);
  const profileRelationshipTypes = await ProfileRelationshipTypeCollection.create(options);
  const oidcIdentities = await OidcIdentityCollection.create(options);
  const tags = await TagCollection.create(options);
  const places = await PlaceCollection.create(options);
  const placeTypes = await PlaceTypeCollection.create(options);
  const facts = await FactCollection.create(options);
  const factSources = await FactSourceCollection.create(options);
  const factEvidences = await FactEvidenceCollection.create(options);
  const factSubjects = await FactSubjectCollection.create(options);
  const factContents = await FactContentCollection.create(options);
  const factTags = await FactTagCollection.create(options);
  const smrtJobs = await SmrtJobCollection.create(options);
  const smrtJobEvents = await SmrtJobEventCollection.create(options);

  await seedSystemRolesWithPermissions(roles);
  await seedEmploymentProfileTypes(profileTypes);
  await seedEmploymentRelationshipTypes(profileRelationshipTypes);
  await seedEmploymentTagContexts(tags);
  await seedEmploymentPlaceTypes(placeTypes);
  await ensureSourceScheduleTable();
  await ensureOpportunityIntelligenceJobDedupe();
  await ensureOpportunityIntelligenceGovernanceSchema();
  await ensureOpportunityIntelligenceControl();
  await ensureCanonicalResumeTailoringConfig();

  initialized.push(
    users.constructor.name,
    tenants.constructor.name,
    memberships.constructor.name,
    sessions.constructor.name,
    roles.constructor.name,
    profiles.constructor.name,
    profileTypes.constructor.name,
    profileRelationships.constructor.name,
    profileRelationshipTypes.constructor.name,
    oidcIdentities.constructor.name,
    tags.constructor.name,
    places.constructor.name,
    placeTypes.constructor.name,
    facts.constructor.name,
    factSources.constructor.name,
    factEvidences.constructor.name,
    factSubjects.constructor.name,
    factContents.constructor.name,
    factTags.constructor.name,
    smrtJobs.constructor.name,
    smrtJobEvents.constructor.name,
    '_smrt_agent_schedules',
    'ResumeTailoringConfig:canonical',
  );

  return initialized;
}

export async function isSmrtNativeBackfillApplied(db: SmrtDatabase): Promise<boolean> {
  const existing = await db.single`
    SELECT 1 FROM _smrt_migrations WHERE version = ${smrtNativeBackfillVersion} LIMIT 1
  `;
  return Boolean(existing);
}

export async function recordSmrtNativeBackfillApplied(db: SmrtDatabase): Promise<void> {
  await db.execute`
    INSERT INTO _smrt_migrations (id, version, description)
    VALUES (${randomUUID()}, ${smrtNativeBackfillVersion}, ${'SMRT-native employment search data backfill'})
    ON CONFLICT(version) DO NOTHING
  `;
}

export async function isResumeAdminBackfillApplied(db: SmrtDatabase): Promise<boolean> {
  const existing = await db.single`
    SELECT 1 FROM _smrt_migrations WHERE version = ${resumeAdminBackfillVersion} LIMIT 1
  `;
  return Boolean(existing);
}

export async function recordResumeAdminBackfillApplied(db: SmrtDatabase): Promise<void> {
  await db.execute`
    INSERT INTO _smrt_migrations (id, version, description)
    VALUES (${randomUUID()}, ${resumeAdminBackfillVersion}, ${'Resume admin source data backfill'})
    ON CONFLICT(version) DO NOTHING
  `;
}

export async function isResumeSourceBackfillApplied(db: SmrtDatabase): Promise<boolean> {
  const existing = await db.single`
    SELECT 1 FROM _smrt_migrations WHERE version = ${resumeSourceBackfillVersion} LIMIT 1
  `;
  return Boolean(existing);
}

export async function recordResumeSourceBackfillApplied(db: SmrtDatabase): Promise<void> {
  await db.execute`
    INSERT INTO _smrt_migrations (id, version, description)
    VALUES (${randomUUID()}, ${resumeSourceBackfillVersion}, ${'Resume source model backfill'})
    ON CONFLICT(version) DO NOTHING
  `;
}

async function seedEmploymentProfileTypes(profileTypes: ProfileTypeCollection) {
  for (const profileType of [
    { slug: 'person', name: 'Person', description: 'Human profile.' },
    { slug: 'organization', name: 'Organization', description: 'Company or organization profile.' },
    { slug: 'agent', name: 'Agent', description: 'Agent or automation profile.' },
  ]) {
    await profileTypes.getOrCreateBySlug(profileType.slug, {
      name: profileType.name,
      description: profileType.description,
    });
  }
}

async function seedEmploymentTagContexts(tags: TagCollection) {
  for (const context of [
    'skill',
    'domain',
    'role',
    'industry',
    'decision_reason',
    'preference',
    'source',
    'credential',
  ]) {
    const tag = await tags.getOrCreate(context, context);
    await tag.save();
  }
}

async function seedEmploymentRelationshipTypes(
  relationshipTypes: ProfileRelationshipTypeCollection,
) {
  for (const relationshipType of [
    { slug: 'works_at', name: 'Works At' },
    { slug: 'founder_of', name: 'Founder Of' },
    { slug: 'recruiter_for', name: 'Recruiter For' },
    { slug: 'hiring_manager_at', name: 'Hiring Manager At' },
    { slug: 'contact_for', name: 'Contact For' },
  ]) {
    await relationshipTypes.getOrCreateBySlug(relationshipType.slug, {
      name: relationshipType.name,
      reciprocal: false,
    });
  }
}

async function seedEmploymentPlaceTypes(placeTypes: PlaceTypeCollection) {
  for (const placeType of [
    { slug: 'country', name: 'Country' },
    { slug: 'region', name: 'Region' },
    { slug: 'city', name: 'City' },
    { slug: 'metro', name: 'Metro' },
    { slug: 'remote_region', name: 'Remote Region' },
  ]) {
    const type = await placeTypes.getOrCreate(placeType.slug, placeType.name);
    await type.save();
  }
}
