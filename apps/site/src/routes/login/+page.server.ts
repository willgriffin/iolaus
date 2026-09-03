import { redirect } from '@sveltejs/kit';
import {
  canUseLocalDevLogin,
  completeLocalDevLogin,
  startOidcLogin,
} from '$lib/server/auth';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = async (event) => {
  const { locals, url } = event;
  if (locals.user) {
    redirect(303, url.searchParams.get('next') ?? '/admin');
  }

  return {
    localDevLogin: canUseLocalDevLogin(event),
    next: url.searchParams.get('next') ?? '/admin',
  };
};

export const actions: Actions = {
  default: async (event) => {
    const form = await event.request.formData();
    const next = String(form.get('next') ?? '/admin');
    event.cookies.set('wg_login_next', next, {
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
