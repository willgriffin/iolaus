import { RoleCollection } from '@happyvertical/smrt-users';
import { applicationRuntime } from '../src/lib/server/application-runtime.js';
import { getSmrtOptions } from '../src/lib/server/db.js';
import { seedSystemRolesWithPermissions } from '../src/lib/server/role-permissions.js';
import '../src/lib/server/smrt.js';

if (
  applicationRuntime.profile !== 'local' ||
  process.env.IOLAUS_ENABLE_DEMO_FIXTURES !== '1'
) {
  throw new Error(
    'Demo owner permissions may only be seeded in an explicitly enabled local demo profile.',
  );
}

const roles = await RoleCollection.create(getSmrtOptions());
await seedSystemRolesWithPermissions(roles);
console.log(
  JSON.stringify({
    schema: 'iolaus-demo-owner-permissions:v1',
    status: 'ready',
    profile: 'local',
  }),
);
