// Hydrate the same explicit application registry as the deployment migrator.
// Its PostgreSQL-only lock/DDL helpers are intentionally not called here.
import './db-common.js';
import { ObjectRegistry, resolveDatabase } from '@happyvertical/smrt-core';
import {
  getDDLStrategy,
  planForeignKeyCreation,
} from '@happyvertical/smrt-core/schema';
import {
  createMigrationDefinition,
  MigrationTracker,
} from '@happyvertical/smrt-core/migrations';
import { getDbConfig } from '../src/lib/server/db.js';

if (
  !process.env.SMRT_APP_ID?.startsWith('iolaus-build-smoke-') ||
  process.env.DATABASE_TYPE !== 'sqlite'
) {
  throw new Error(
    'Smoke schema initialization requires its isolated SQLite runtime.',
  );
}
const db = await resolveDatabase(getDbConfig());
const strategy = getDDLStrategy('sqlite');
const plan = planForeignKeyCreation(
  Object.values(ObjectRegistry.getAllSchemasAsDefinitions()),
  'sqlite',
);
const statements = plan.schemas.flatMap((schema) => [
  strategy.generateCreateTable(schema),
  ...strategy.generateIndexes(schema),
  ...strategy.generateTriggers(schema),
]);
statements.push(...plan.deferredStatements);
const tracker = new MigrationTracker({ db });
const results = await tracker.applyAll([
  createMigrationDefinition(
    '20261013000000_smoke_empty_schema',
    statements,
    [],
    {
      description: 'Initialize the isolated built-server smoke database',
      packageName: '@willgriffin/iolaus-site',
      version: '0.1.0',
    },
  ),
]);
const failed = results.find((result) => !result.success);
if (failed)
  throw failed.error ?? new Error('Smoke schema initialization failed.');
