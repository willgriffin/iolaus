import '../src/lib/server/manifest-preload.js';
import '../src/lib/server/smrt.js';
import { resolveDatabase } from '@happyvertical/smrt-core';
import { getDbConfig } from '../src/lib/server/db.js';
import {
  inspectWorkspaceOwnershipEnforcement,
  workspaceOwnershipSchemaEnforced,
} from '../src/lib/server/workspace-ownership-schema.js';

const configuration = getDbConfig();
const database = await resolveDatabase(configuration);
const tables = await inspectWorkspaceOwnershipEnforcement(
  database,
  configuration.type,
);
const enforced = workspaceOwnershipSchemaEnforced(tables);

console.log(
  JSON.stringify(
    {
      enforced,
      mode: 'post-backfill-enforcement-check',
      tables,
    },
    null,
    2,
  ),
);
if (!enforced) process.exitCode = 2;
