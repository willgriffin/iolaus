import { detectEngine, resolveDatabase } from '@happyvertical/smrt-core';
import { type Actions, fail, redirect } from '@sveltejs/kit';
import {
  ACCOUNT_DELETION_CONFIRMATION_PHRASE,
  ACCOUNT_DELETION_DISABLED_MESSAGE,
  type AccountDeletionDatabase,
  AccountDeletionError,
  accountDeletionConfirmed,
  accountDeletionMode,
  deleteAccount,
} from '$lib/server/account-deletion';
import { getAppConfig } from '$lib/server/app-config';
import { sessionCookieName } from '$lib/server/auth';
import { getDbConfig } from '$lib/server/db';
import { getResumeFilesystem } from '$lib/server/resume-files';
import {
  WorkspaceSubjectError,
  workspaceSubjectFromLocals,
} from '$lib/server/workspace-subject';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = ({ locals, setHeaders }) => {
  setHeaders({ 'cache-control': 'no-store' });
  return {
    appName: getAppConfig().appName,
    confirmationPhrase: ACCOUNT_DELETION_CONFIRMATION_PHRASE,
    deletionEnabled: accountDeletionMode() === 'enabled',
    deletionDisabledMessage: ACCOUNT_DELETION_DISABLED_MESSAGE,
    email: locals.user?.email ?? '',
  };
};

function text(value: FormDataEntryValue | null): string {
  return typeof value === 'string' ? value : '';
}

export const actions: Actions = {
  /**
   * Delete the signed-in user's own account. Authority is the verified
   * session subject only; the form carries no tenant or user id.
   */
  delete: async (event) => {
    if (accountDeletionMode() !== 'enabled') {
      return fail(403, { error: ACCOUNT_DELETION_DISABLED_MESSAGE });
    }
    let subject: ReturnType<typeof workspaceSubjectFromLocals>;
    try {
      subject = workspaceSubjectFromLocals(event.locals);
    } catch (cause) {
      if (cause instanceof WorkspaceSubjectError) {
        return fail(cause.status, {
          error: 'Sign in again before deleting your account.',
        });
      }
      throw cause;
    }

    const form = await event.request.formData();
    const confirmed =
      form.get('acknowledge') === 'on' &&
      accountDeletionConfirmed({
        email: event.locals.user?.email,
        typedEmail: text(form.get('confirmEmail')),
        typedPhrase: text(form.get('confirmPhrase')),
      });
    if (!confirmed) {
      return fail(400, {
        error:
          'Confirmation did not match. Tick the box, then type your email address and the phrase exactly.',
      });
    }

    try {
      const database = await resolveDatabase(getDbConfig());
      const result = await deleteAccount(
        { tenantId: subject.tenantId, userId: subject.userId },
        {
          database: database as unknown as AccountDeletionDatabase,
          dialect:
            database.url && detectEngine(database.url) === 'sqlite'
              ? 'sqlite'
              : 'postgres',
          filesystem: await getResumeFilesystem(),
          initiatedBy: 'self',
        },
      );
      // Structured and free of identifiers: ids and email are never logged.
      console.info(
        JSON.stringify({
          event: 'account.deleted',
          deletionId: result.deletionId,
          status: result.status,
          summary: result.summary,
        }),
      );
    } catch (cause) {
      console.error(
        JSON.stringify({
          event: 'account.deletion_failed',
          code: cause instanceof AccountDeletionError ? cause.code : 'unknown',
        }),
      );
      return fail(500, {
        error:
          'Your account could not be fully deleted. It has been locked and cannot be used; the operator can finish the deletion. Please contact support.',
      });
    }

    event.cookies.delete(sessionCookieName, { path: '/' });
    redirect(303, '/account-deleted/');
  },
};
