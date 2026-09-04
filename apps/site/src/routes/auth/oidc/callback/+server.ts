import { redirect } from '@sveltejs/kit';
import { completeOidcLogin, loginNextCookieName } from '$lib/server/auth';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async (event) => {
  await completeOidcLogin(event);

  const next = event.cookies.get(loginNextCookieName) ?? '/admin';
  event.cookies.delete(loginNextCookieName, { path: '/' });
  redirect(303, next);
};
