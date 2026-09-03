import { fail } from '@sveltejs/kit';
import {
  approveCliAuthRequest,
  getCliAuthRequestForUserCode,
} from '$lib/server/terminal-auth';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ url }) => {
  const userCode = url.searchParams.get('code')?.trim().toUpperCase() ?? '';
  const request = userCode
    ? await getCliAuthRequestForUserCode(userCode)
    : null;

  return {
    requestStatus: request?.status ?? null,
    userCode,
  };
};

export const actions: Actions = {
  approve: async (event) => {
    const formData = await event.request.formData();
    const userCode =
      formData.get('userCode')?.toString().trim().toUpperCase() ?? '';

    if (!userCode) {
      return fail(400, { error: 'Enter a terminal login code.', userCode });
    }

    if (!event.locals.user) {
      return fail(401, {
        error: 'Sign in before approving terminal access.',
        userCode,
      });
    }

    try {
      const request = await approveCliAuthRequest({
        ipAddress: event.getClientAddress(),
        tenantId: event.locals.tenantId,
        user: event.locals.user,
        userAgent: event.request.headers.get('user-agent') ?? undefined,
        userCode,
      });

      return {
        approved: true,
        requestStatus: request.status,
        userCode,
      };
    } catch (error) {
      return fail(400, {
        error:
          error instanceof Error
            ? error.message
            : 'Unable to approve terminal login.',
        userCode,
      });
    }
  },
};
