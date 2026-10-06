import { adminResources } from '$lib/admin/resources';
import { isAdminAssistantEnabled } from '$lib/server/admin-assistant-config';
import { getAppConfig } from '$lib/server/app-config';
import type { LayoutServerLoad } from './$types';

export const load: LayoutServerLoad = async ({ locals }) => {
  return {
    assistantEnabled: isAdminAssistantEnabled(),
    // A client disposal key only; activity reads independently verify ownership.
    activityScopeKey: locals.workspaceSubject?.profileId
      ? JSON.stringify([
          locals.workspaceSubject.tenantId,
          locals.workspaceSubject.userId,
          locals.workspaceSubject.profileId,
        ])
      : null,
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
