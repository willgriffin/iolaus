import '../src/lib/server/manifest-preload.js';
import '../src/lib/server/smrt.js';
import { resolveDatabase } from '@happyvertical/smrt-core';
import { getDbConfig } from '../src/lib/server/db.js';
import {
  applyWorkspaceOwnershipBackfill,
  planWorkspaceOwnershipBackfill,
  requireWorkspaceOwnershipBinding,
} from '../src/lib/server/workspace-ownership-backfill.js';

const argumentsList = process.argv.slice(2);
const apply = argumentsList.includes('--apply');

function option(name: string): string {
  const index = argumentsList.indexOf(name);
  return index < 0 ? '' : String(argumentsList[index + 1] ?? '');
}

const allowed = new Set([
  '--apply',
  '--candidate-profile-id',
  '--owner-user-id',
  '--tenant-id',
  '--expected-plan-sha256',
]);
for (const argument of argumentsList) {
  if (argument.startsWith('--') && !allowed.has(argument)) {
    throw new Error(`Unknown argument: ${argument}`);
  }
}

const binding = requireWorkspaceOwnershipBinding({
  candidateProfileId: option('--candidate-profile-id'),
  ownerUserId: option('--owner-user-id'),
  tenantId: option('--tenant-id'),
});
const expectedDigest = option('--expected-plan-sha256');
if (apply && !expectedDigest) {
  throw new Error('--apply requires --expected-plan-sha256 from the reviewed dry run.');
}

const databaseConfig = getDbConfig();
const database = await resolveDatabase(databaseConfig);
const options = { binding, dialect: databaseConfig.type };
const plan = apply
  ? await applyWorkspaceOwnershipBackfill(database, { ...options, expectedDigest })
  : await planWorkspaceOwnershipBackfill(database, options);

// Do not print identities or row IDs. The digest binds them for the reviewed
// apply without turning operator output into a personal-data inventory.
console.log(JSON.stringify({
  eligible: plan.eligible,
  mode: apply ? 'applied' : 'dry-run',
  planSha256: plan.digest,
  profileCardinalityValid: plan.profileCardinalityValid,
  tables: plan.tables,
}, null, 2));
if (!plan.eligible) process.exitCode = 2;
