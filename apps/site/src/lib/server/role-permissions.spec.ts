import { describe, expect, it, vi } from 'vitest';
import { seedSystemRolesWithPermissions } from './role-permissions';

describe('seedSystemRolesWithPermissions', () => {
  it('opts into idempotent manifest permission and role mapping seeding', async () => {
    const seedSystemRoles = vi.fn(async () => []);

    await seedSystemRolesWithPermissions({ seedSystemRoles });

    expect(seedSystemRoles).toHaveBeenCalledOnce();
    expect(seedSystemRoles).toHaveBeenCalledWith({ seedPermissions: true });
  });
});
