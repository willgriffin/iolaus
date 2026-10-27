import type { SmrtClassOptions } from '@happyvertical/smrt-core';
import {
  DEFAULT_ROLE_SLUGS,
  type RoleCollection,
  RolePermissionCollection,
  type RolePermissionPatternMatrix,
} from '@happyvertical/smrt-users';
import { HOSTED_OPERATOR_ROLE_SLUG } from './hosted-operator-role.js';
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

export const hostedOperatorPermissions = [
  ...iolausRolePermissionMatrix.member,
  'sources.read',
  'sources.create',
  'sources.update',
  'sourcecrawls.read',
  'sourcecrawlitems.read',
  'opportunities.create',
  'opportunities.update',
  'companies.create',
  'companies.update',
] as const;

/** Called only after the authenticated email matches the current operator list. */
export async function ensureHostedOperatorRole(
  roles: RoleCollection,
  options: SmrtClassOptions,
  tenantId: string,
) {
  let role = await roles.findBySlug(HOSTED_OPERATOR_ROLE_SLUG, tenantId);
  if (!role || role.tenantId !== tenantId) {
    try {
      role = await roles.create({
        slug: HOSTED_OPERATOR_ROLE_SLUG,
        name: 'Catalog operator',
        description: 'Workspace workflows and installation source operations.',
        tenantId,
        isSystem: false,
      });
    } catch (cause) {
      role = await roles.findBySlug(HOSTED_OPERATOR_ROLE_SLUG, tenantId);
      if (!role || role.tenantId !== tenantId) throw cause;
    }
  }
  await (await RolePermissionCollection.create(options)).seedRolePermissions(
    { [HOSTED_OPERATOR_ROLE_SLUG]: hostedOperatorPermissions },
    { tenantId, prune: true },
  );
  return role;
}

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
