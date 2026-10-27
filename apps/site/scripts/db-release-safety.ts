import { ObjectRegistry } from '@happyvertical/smrt-core';
import type { DeploymentStepTransaction } from '@happyvertical/smrt-core/migrations';
import { assertRuntimeStaticAgreement } from '../../../scripts/smrt-deployment-schema.mjs';
import {
  observeWriterExclusion,
  type ReleaseIdentity,
} from '../src/lib/server/deployment/observer.js';
import { readApplicationDeploymentSchemas } from '../src/lib/server/deployment/static-schemas.js';

/** No supplied quiescence flags: each call obtains fresh cluster + DB evidence. */
export function createReleaseSafetyCheck(identity: ReleaseIdentity) {
  return async (connection: DeploymentStepTransaction): Promise<void> => {
    const schemas = await readApplicationDeploymentSchemas();
    assertRuntimeStaticAgreement(
      ObjectRegistry.getAllSchemasAsDefinitions(),
      schemas,
    );
    await observeWriterExclusion(identity);
    // Dedicated maintenance principal only. Runtime/monitor sessions must be
    // drained by the platform; this command never terminates another backend.
    const result = await connection.query(`SELECT EXISTS (
      SELECT 1 FROM pg_stat_activity
      WHERE datid = (SELECT oid FROM pg_database WHERE datname = current_database())
        AND backend_type = 'client backend' AND usename IS DISTINCT FROM current_user
    ) AS foreign_sessions`);
    if (result.rows[0]?.foreign_sessions !== false)
      throw new Error(
        'Database writer exclusion is unproven; drain non-maintenance sessions.',
      );
  };
}
