import { error, redirect } from '@sveltejs/kit';
import { safeNextPath } from '$lib/safe-next';
import { getAppConfig, getAuthConfiguration } from '$lib/server/app-config';
import { completeMagicLinkLogin, loginNextCookieName } from '$lib/server/auth';
import type { Actions, PageServerLoad } from './$types';

function requireMagicLinkMode(): void {
  if (getAuthConfiguration().kind !== 'magic-link') error(404, 'Not found');
}

/**
 * Opening the emailed link only renders a confirmation. The single-use token
 * is consumed by the POST below, so a mail scanner or link previewer that
 * fetches the URL cannot burn the link before the person clicks it.
 */
export const load: PageServerLoad = async ({ setHeaders, url }) => {
  requireMagicLinkMode();
  setHeaders({
    'cache-control': 'no-store',
    'referrer-policy': 'no-referrer',
  });
  return {
    appName: getAppConfig().appName,
    token: url.searchParams.get('token') ?? '',
  };
};

export const actions: Actions = {
  default: async (event) => {
    requireMagicLinkMode();
    const form = await event.request.formData();
    const token = String(form.get('token') ?? '');

    const result = await completeMagicLinkLogin(event, token);
    if (result === 'not-invited') redirect(303, '/not-invited');
    if (result === 'invalid') {
      return { invalid: true as const };
    }

    const next = safeNextPath(event.cookies.get(loginNextCookieName));
    event.cookies.delete(loginNextCookieName, { path: '/' });
    redirect(303, next);
  },
};
