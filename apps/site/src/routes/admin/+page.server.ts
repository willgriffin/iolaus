import {
  getCurrentSessionPermissionContext,
  withSessionPermissionContext,
} from '@happyvertical/smrt-users';
import { error } from '@sveltejs/kit';
import { loadAdminOverview } from '$lib/server/admin-overview';
import { getSmrtOptions } from '$lib/server/db';
import {
  type WorkspaceSubject,
  withVerifiedWorkspaceSubject,
  workspaceSubjectFromLocals,
} from '$lib/server/workspace-subject';
import type { PageServerLoad } from './$types';

function loadOverviewInSession(subject: WorkspaceSubject, sessionId: string) {
  // SMRT closes the hook's RLS transaction when the response is returned.
  // Give the streamed work its own transaction with the same verified session.
  return withSessionPermissionContext(
    {
      ...getSmrtOptions(),
      enterTenantContext: true,
      postgresRls: true,
      sessionId,
    },
    async (session) => {
      if (
        !session.session ||
        session.tenantId !== subject.tenantId ||
        session.userId !== subject.userId
      )
        error(403, 'A verified session is required.');
      return withVerifiedWorkspaceSubject(subject, loadAdminOverview);
    },
  );
}

export const load = (async ({ locals }) => {
  const subject = workspaceSubjectFromLocals(locals);
  const request = getCurrentSessionPermissionContext();
  if (request?.postgresRls && !request.sessionId)
    error(403, 'A verified session is required.');
  const overview =
    request?.postgresRls && request.sessionId
      ? loadOverviewInSession(subject, request.sessionId)
      : loadAdminOverview(subject);
  // The layout can still be loading when the overview rejects. Let SvelteKit
  // serialize that rejection without leaving it temporarily unhandled.
  void overview.catch(() => {});
  return { overview };
}) satisfies PageServerLoad;
