import { redirect } from '@sveltejs/kit';
import { getAppConfig } from '$lib/server/app-config';
import {
  canUseLocalDevLogin,
  completeLocalDevLogin,
  loginNextCookieName,
  startOidcLogin,
} from '$lib/server/auth';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = async (event) => {
  const { locals, url } = event;
  if (locals.user) {
    redirect(303, url.searchParams.get('next') ?? '/admin');
  }

  return {
    appName: getAppConfig().appName,
    localDevLogin: canUseLocalDevLogin(event),
    next: url.searchParams.get('next') ?? '/admin',
  };
};

export const actions: Actions = {
  default: async (event) => {
    const form = await event.request.formData();
    const next = String(form.get('next') ?? '/admin');
    event.cookies.set(loginNextCookieName, next, {
      httpOnly: true,
      maxAge: 10 * 60,
      path: '/',
      sameSite: 'lax',
      secure: event.url.protocol === 'https:',
    });

    if (canUseLocalDevLogin(event)) {
      await completeLocalDevLogin(event);
      redirect(303, next);
    }

    redirect(303, await startOidcLogin(event));
  },
};
