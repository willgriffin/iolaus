import { redirect } from '@sveltejs/kit';
import { safeNextPath } from '$lib/safe-next';
import { completeOidcLogin, loginNextCookieName } from '$lib/server/auth';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async (event) => {
  await completeOidcLogin(event);

  const next = safeNextPath(event.cookies.get(loginNextCookieName));
  event.cookies.delete(loginNextCookieName, { path: '/' });
  redirect(303, next);
};
