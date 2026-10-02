import '../src/lib/server/manifest-preload.js';
import '../src/lib/server/smrt.js';
import { resolveDatabase } from '@happyvertical/smrt-core';
import { getDbConfig } from '../src/lib/server/db.js';
import {
  prepareWorkspaceOwnershipSchema,
  workspaceOwnershipSchemaPrepared,
} from '../src/lib/server/workspace-ownership-schema.js';

const configuration = getDbConfig();
const database = await resolveDatabase(configuration);
const tables = await prepareWorkspaceOwnershipSchema(database, configuration.type);
const prepared = workspaceOwnershipSchemaPrepared(tables);

console.log(
  JSON.stringify(
    {
      mode: 'additive-nullable-schema-phase',
      nativeEmptyTablesRequired: tables
        .filter(({ needsNativeCreate }) => needsNativeCreate)
        .map(({ table }) => table),
      prepared,
      tables: tables.map(
        ({ addedColumns, needsNativeCreate, table, tablePresent }) => ({
        addedColumns,
        needsNativeCreate,
        table,
        tablePresent,
        }),
      ),
    },
    null,
    2,
  ),
);
if (!prepared) process.exitCode = 2;
