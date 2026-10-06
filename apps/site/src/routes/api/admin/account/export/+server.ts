import { error } from '@sveltejs/kit';
import {
  accountExportFilename,
  buildAccountExport,
} from '$lib/server/account-export';
import {
  getAppConfig,
  getConfiguredPublicOrigin,
} from '$lib/server/app-config';
import { getResumeFilesystem } from '$lib/server/resume-files';
import {
  WorkspaceSubjectError,
  workspaceSubjectFromLocals,
} from '$lib/server/workspace-subject';
import type { RequestHandler } from './$types';

/**
 * Download the signed-in user's own workspace as JSON. The subject comes only
 * from the verified session; there is no id, tenant or profile parameter, and
 * every record is read through the owner-scoped private-record helpers.
 * Available in private and shared mode (the private owner exports their own
 * workspace too).
 */
export const GET: RequestHandler = async ({ locals, url }) => {
  let subject: ReturnType<typeof workspaceSubjectFromLocals>;
  try {
    subject = workspaceSubjectFromLocals(locals);
  } catch (cause) {
    if (cause instanceof WorkspaceSubjectError) {
      error(cause.status, 'A verified workspace session is required.');
    }
    throw cause;
  }

  let filesystem: Awaited<ReturnType<typeof getResumeFilesystem>> | undefined;
  try {
    filesystem = await getResumeFilesystem();
  } catch {
    // Presence flags are informational; the export does not depend on storage.
  }

  const now = new Date();
  const body = await buildAccountExport(
    subject,
    { email: locals.user?.email },
    {
      filesystem,
      now: () => now,
      origin: getConfiguredPublicOrigin() ?? url.origin,
      workspaceMode: getAppConfig().workspaceMode,
    },
  );
  return new Response(JSON.stringify(body, null, 2), {
    headers: {
      'cache-control': 'no-store',
      'content-disposition': `attachment; filename="${accountExportFilename(now)}"`,
      'content-type': 'application/json; charset=utf-8',
      'x-content-type-options': 'nosniff',
    },
  });
};
