import { ObjectRegistry } from '@happyvertical/smrt-core';
import type { DatabaseInterface } from '@happyvertical/sql';
import {
  assertDeploymentCatalogReady,
  assertDeploymentSchemaReady,
  assertRuntimeDatabaseRole,
  assertRuntimeStaticAgreement,
} from '../../../../../../scripts/smrt-deployment-schema.mjs';
import { readApplicationDeploymentSchemas } from './static-schemas.js';

export async function assertDeployedSchemaReady(
  db: DatabaseInterface,
): Promise<void> {
  // Evaluate the full app registry only after module initialization, avoiding
  // the db -> application-runtime -> registry bootstrap import cycle.
  await import('../smrt.js');
  await import('@happyvertical/smrt-ingestion/models');
  const { registerDeploymentSchemaMetadata } = await import(
    './register-schemas.js'
  );
  registerDeploymentSchemaMetadata();
  const schemas = await readApplicationDeploymentSchemas();
  assertRuntimeStaticAgreement(
    ObjectRegistry.getAllSchemasAsDefinitions(),
    schemas,
  );
  await assertRuntimeDatabaseRole(db);
  await assertDeploymentSchemaReady(
    db,
    Object.values(ObjectRegistry.getAllSchemasAsDefinitions()),
  );
  await assertDeploymentCatalogReady(
    db,
    Object.values(ObjectRegistry.getAllSchemasAsDefinitions()),
  );
}
