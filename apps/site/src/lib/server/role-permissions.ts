import {
  DEFAULT_ROLE_SLUGS,
  type RoleCollection,
  type RolePermissionPatternMatrix,
} from '@happyvertical/smrt-users';
import { workspaceWorkflowCapabilitySlugs } from './workspace-workflow-capabilities.js';

type SystemRoleSeeder = Pick<RoleCollection, 'seedSystemRoles'>;

/**
 * Shared hosted workspaces create a native MEMBER role. These explicit grants
 * make the subject-bound workflows usable without granting private model CRUD.
 */
export const iolausRolePermissionMatrix = {
  // Private installations retain their configured operator roles. The public
  // hosted member must not inherit SMRT's broad `*.create` or private model
  // read patterns merely because it has an active tenant membership.
  [DEFAULT_ROLE_SLUGS.ADMIN]: ['*'],
  [DEFAULT_ROLE_SLUGS.MEMBER]: [
    'companies.read',
    'opportunities.read',
    ...workspaceWorkflowCapabilitySlugs,
  ],
  [DEFAULT_ROLE_SLUGS.OWNER]: ['*'],
  [DEFAULT_ROLE_SLUGS.VIEWER]: ['companies.read', 'opportunities.read'],
} satisfies RolePermissionPatternMatrix;

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
  await roles.seedSystemRoles({
    permissionMatrix: iolausRolePermissionMatrix,
    seedPermissions: true,
  });
}
