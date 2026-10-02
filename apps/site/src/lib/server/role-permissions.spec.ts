import { describe, expect, it, vi } from 'vitest';
import {
  iolausRolePermissionMatrix,
  seedSystemRolesWithPermissions,
} from './role-permissions';
import { workspaceWorkflowCapabilitySlugs } from './workspace-workflow-capabilities';

describe('seedSystemRolesWithPermissions', () => {
  it('opts into idempotent manifest permission and role mapping seeding', async () => {
    const seedSystemRoles = vi.fn(async () => []);

    await seedSystemRolesWithPermissions({ seedSystemRoles });

    expect(seedSystemRoles).toHaveBeenCalledOnce();
    expect(seedSystemRoles).toHaveBeenCalledWith({
      permissionMatrix: iolausRolePermissionMatrix,
      seedPermissions: true,
    });
    expect(iolausRolePermissionMatrix.member).toEqual(
      expect.arrayContaining(workspaceWorkflowCapabilitySlugs),
    );
  });
});
