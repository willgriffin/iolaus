// Manifest preload + complete model registration must precede schema inspection.
import './db-common.js';
import { ObjectRegistry, resolveDatabase } from '@happyvertical/smrt-core';
import { getDbConfig } from '../src/lib/server/db.js';
import { releaseIdentity } from '../src/lib/server/deployment/observer.js';
import { assertDeploymentSchemaReady } from '../../../scripts/smrt-deployment-schema.mjs';
import { withSmrtDatabaseMigrationLock } from './db-common.js';
import { parseDbMigrateOptions } from './db-migrate-options.js';
import { createReleaseSafetyCheck } from './db-release-safety.js';
import {
  finalizeReleaseIntegrity,
  prepareReleaseSchema,
  verifyReleaseIntegrity,
} from './db-release-schema.js';
import { releaseCatalog } from './db-release-catalog.js';
import { executeReleaseCatalog } from './db-release-executor.js';

const { maintenanceWindow } = parseDbMigrateOptions(process.argv.slice(2));
if (!maintenanceWindow)
  throw new Error('Dedicated release migration requires --maintenance-window.');
if (getDbConfig().type !== 'postgres')
  throw new Error(
    'Dedicated release migration supports PostgreSQL only; local onboarding is unchanged.',
  );
const identity = releaseIdentity();
const database = await resolveDatabase(getDbConfig());
try {
  const checkSafety = createReleaseSafetyCheck(identity);
  await withSmrtDatabaseMigrationLock(async () => {
    await prepareReleaseSchema(database, () => checkSafety(database));
    const steps = await executeReleaseCatalog({
      database,
      application: identity.application,
      environment: identity.environment,
      checkSafety,
      steps: releaseCatalog(database),
    });
    await finalizeReleaseIntegrity(database, () => checkSafety(database));
    await checkSafety(database);
    await assertDeploymentSchemaReady(
      database,
      Object.values(ObjectRegistry.getAllSchemasAsDefinitions()),
    );
    await verifyReleaseIntegrity(database);
    console.log(
      JSON.stringify({
        status: 'complete',
        release: identity.release,
        attempt: identity.attempt,
        schema: 'verified',
        data: steps.map((step) => ({ id: step.stepId, status: step.status })),
        legacyPersonalResumeBackfills: 'disabled',
      }),
    );
  }, database);
} finally {
  await database.close?.();
}
