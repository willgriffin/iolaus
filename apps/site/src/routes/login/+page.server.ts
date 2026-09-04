import { redirect } from '@sveltejs/kit';
import { getAppConfig } from '$lib/server/app-config';
import { applicationRuntime } from '$lib/server/application-runtime';
import {
  canUseLocalDevLogin,
  completeLocalDevLogin,
  loginNextCookieName,
  shouldUseSecureCookies,
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
      secure: shouldUseSecureCookies(
        applicationRuntime.profile,
        event.url.protocol,
      ),
    });

    if (canUseLocalDevLogin(event)) {
      await completeLocalDevLogin(event);
      redirect(303, next);
    }

    redirect(303, await startOidcLogin(event));
  },
};
