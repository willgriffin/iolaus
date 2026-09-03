import type { RoleCollection } from '@happyvertical/smrt-users';

type SystemRoleSeeder = Pick<RoleCollection, 'seedSystemRoles'>;

/**
 * Keep built-in roles and their manifest-derived permission mappings current.
 *
 * SMRT intentionally makes permission seeding opt-in. Calling
 * `seedSystemRoles()` alone creates the roles but leaves authenticated session
 * permission snapshots empty, which makes guarded application routes fail
 * closed.
 */
export async function seedSystemRolesWithPermissions(
  roles: SystemRoleSeeder,
): Promise<void> {
  await roles.seedSystemRoles({ seedPermissions: true });
}
