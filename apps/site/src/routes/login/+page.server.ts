import { fail, redirect } from '@sveltejs/kit';
import {
  getAppConfig,
  getAuthConfiguration,
  getPublicLinks,
} from '$lib/server/app-config';
import { applicationRuntime } from '$lib/server/application-runtime';
import {
  canUseLocalDevLogin,
  completeLocalDevLogin,
  loginNextCookieName,
  shouldUseSecureCookies,
  startOidcLogin,
} from '$lib/server/auth';
import { requestMagicLink } from '$lib/server/magic-link-login';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = async (event) => {
  const { locals, url } = event;
  if (locals.user) {
    redirect(303, url.searchParams.get('next') ?? '/admin');
  }

  return {
    appName: getAppConfig().appName,
    links: getPublicLinks(),
    localDevLogin: canUseLocalDevLogin(event),
    magicLink: getAuthConfiguration().kind === 'magic-link',
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

    if (getAuthConfiguration().kind === 'magic-link') {
      const email = String(form.get('email') ?? '').trim();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(email) || email.length > 254) {
        return fail(400, { invalidEmail: true });
      }
      // Answer identically for every well-formed address and do the work after
      // responding, so neither the body nor the latency reveals whether the
      // address is invited. Failures are logged without the address or link.
      void requestMagicLink(email, event.getClientAddress()).catch(() => {
        console.error('Magic-link request failed.');
      });
      return { sent: true };
    }

    if (canUseLocalDevLogin(event)) {
      await completeLocalDevLogin(event);
      redirect(303, next);
    }

    redirect(303, await startOidcLogin(event));
  },
};
