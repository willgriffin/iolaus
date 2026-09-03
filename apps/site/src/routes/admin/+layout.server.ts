import { adminResources } from '$lib/admin/resources';
import type { LayoutServerLoad } from './$types';

export const load: LayoutServerLoad = async ({ locals }) => {
  return {
    permissions: locals.permissions,
    resources: adminResources,
    tenantId: locals.tenantId,
    user: locals.user
      ? {
          id: locals.user.id,
          email: locals.user.email,
        }
      : null,
  };
};
