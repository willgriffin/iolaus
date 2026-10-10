import { resolveDatabase } from '@happyvertical/smrt-core';
import { error } from '@sveltejs/kit';
import {
  accountExportFilename,
  buildAccountExport,
} from '$lib/server/account-export';
import {
  getAppConfig,
  getConfiguredPublicOrigin,
} from '$lib/server/app-config';
import { getDbConfig } from '$lib/server/db';
import { createPublicProfileStore } from '$lib/server/public-profile-store';
import { getResumeFilesystem } from '$lib/server/resume-files';
import { createShortlistStore } from '$lib/server/shortlist-store';
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
  const publicProfileExport = async (owner: {
    tenantId: string;
    userId: string;
  }) => {
    try {
      const exported = await createPublicProfileStore(
        await resolveDatabase(getDbConfig()),
      ).exportOwner(owner);
      if (!exported.identity) return null;
      return {
        identity: {
          candidateProfileId: exported.identity.candidateProfileId,
          currentRevisionId: exported.identity.currentRevisionId,
          deletedAt: exported.identity.deletedAt,
          handle: exported.identity.handle,
          revision: exported.identity.revision,
        },
        revisions: exported.revisions,
      };
    } catch (cause) {
      // Existing installations can export before the feature's migration.
      const message = String(cause);
      if (
        /public_profile_(identities|revisions)/iu.test(message) &&
        /no such table|does not exist/iu.test(message)
      )
        return null;
      throw cause;
    }
  };
  const body = await buildAccountExport(
    subject,
    { email: locals.user?.email },
    {
      filesystem,
      now: () => now,
      origin: getConfiguredPublicOrigin() ?? url.origin,
      publicProfileExport,
      shortlistExport: async (owner) => {
        try {
          return await createShortlistStore(
            await resolveDatabase(getDbConfig()),
          ).list(owner);
        } catch (cause) {
          // Preserve export availability before the shortlist migration.
          const message = String(cause);
          if (
            /shortlist_entries/iu.test(message) &&
            /no such table|does not exist/iu.test(message)
          )
            return [];
          throw cause;
        }
      },
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
