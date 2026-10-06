import { adminResources } from '$lib/admin/resources';
import { isAdminAssistantEnabled } from '$lib/server/admin-assistant-config';
import { getAiUsageSummary } from '$lib/server/ai-usage-guard';
import { getAppConfig } from '$lib/server/app-config';
import type { LayoutServerLoad } from './$types';

/** Small remaining-budget indicator; absent when no cap applies. */
async function aiBudgetIndicator(locals: App.Locals) {
  const subject = locals.workspaceSubject;
  if (!subject?.tenantId || !subject.userId) return null;
  try {
    const summary = await getAiUsageSummary(subject);
    if (!summary) return null;
    const exhausted = summary.remainingMicros === 0;
    return {
      detail: summary.capped
        ? 'Your AI usage budget. Heavy use of AI review features draws it down.'
        : 'AI features are temporarily turned off.',
      disabled: summary.disabled,
      exhausted,
      label: summary.disabled
        ? 'AI paused'
        : exhausted
          ? 'AI budget used up'
          : (summary.remainingLabel ?? ''),
    };
  } catch {
    // Never let budget display break the shell.
    return null;
  }
}

export const load: LayoutServerLoad = async ({ locals }) => {
  return {
    aiBudget: await aiBudgetIndicator(locals),
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
