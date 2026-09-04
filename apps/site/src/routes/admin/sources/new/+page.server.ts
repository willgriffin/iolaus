import { type Actions, fail, redirect } from '@sveltejs/kit';
import {
  isOwnerAuthorityDenial,
  OwnerPrincipalError,
  runAsOwner,
} from '$lib/server/owner-principal.js';
import {
  createRootSource,
  parseRootSourceSetup,
  rootSourceTypeOptions,
} from '$lib/server/source-root-setup.js';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async () => ({
  sourceTypes: rootSourceTypeOptions,
});

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : 'Unable to save this source.';
}

export const actions: Actions = {
  create: async ({ locals, request }) => {
    let source: { id: string };
    try {
      source = await runAsOwner(
        locals,
        async (run) => {
          await run.assertOperation('sources', 'create');
          return await createRootSource(
            parseRootSourceSetup(await request.formData()),
          );
        },
        {
          action: 'admin.create_root_source',
          auditMetadata: { sourceRole: 'root' },
        },
      );
    } catch (cause) {
      if (cause instanceof OwnerPrincipalError) {
        return fail(401, { error: 'Sign in before adding a source.' });
      }
      if (isOwnerAuthorityDenial(cause)) {
        return fail(403, {
          error: 'You do not have permission to add sources.',
        });
      }
      return fail(400, { error: errorMessage(cause) });
    }
    redirect(303, `/admin/sources/${encodeURIComponent(source.id)}`);
  },
};
