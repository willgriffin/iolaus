import {
  releaseIdentity,
  waitForWriterFenceEnrollment,
} from '../src/lib/server/deployment/observer.js';
import {
  assertDeploymentSchemaReady,
  releaseDeploymentProtocolEnabled,
} from '../../../scripts/smrt-deployment-schema.mjs';
import { parseDbMigrateOptions } from './db-migrate-options.js';

const { maintenanceWindow } = parseDbMigrateOptions(process.argv.slice(2));
if (!maintenanceWindow)
  throw new Error('Dedicated release migration requires --maintenance-window.');
if (!releaseDeploymentProtocolEnabled())
  throw new Error(
    'Dedicated release migration requires IOLAUS_DEPLOYMENT_PROTOCOL=smrt-release-v1.',
  );
const identity = releaseIdentity();
await waitForWriterFenceEnrollment(identity);
// No database-related import or initialization precedes native enrollment.
// Preserve manifest preload before evaluating any model/schema closure.
const { withSmrtDatabaseMigrationLock } = await import('./db-common.js');
const { ObjectRegistry, resolveDatabase } = await import(
  '@happyvertical/smrt-core'
);
const { getDbConfig } = await import('../src/lib/server/db.js');
const { createReleaseSafetyCheck } = await import('./db-release-safety.js');
const {
  finalizeReleaseIntegrity,
  prepareReleaseSchema,
  verifyReleaseIntegrity,
} = await import('./db-release-schema.js');
const { releaseCatalog } = await import('./db-release-catalog.js');
const { executeReleaseCatalog } = await import('./db-release-executor.js');
if (getDbConfig().type !== 'postgres')
  throw new Error(
    'Dedicated release migration supports PostgreSQL only; local onboarding is unchanged.',
  );
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
