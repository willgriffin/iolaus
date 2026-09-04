import { adminResources } from '$lib/admin/resources';
import { getAppConfig } from '$lib/server/app-config';
import type { LayoutServerLoad } from './$types';

export const load: LayoutServerLoad = async ({ locals }) => {
  return {
    appMark: getAppConfig().appMark,
    appName: getAppConfig().appName,
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
