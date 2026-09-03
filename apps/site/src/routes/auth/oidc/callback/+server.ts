import { redirect } from '@sveltejs/kit';
import { completeOidcLogin } from '$lib/server/auth';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async (event) => {
  await completeOidcLogin(event);

  const next = event.cookies.get('wg_login_next') ?? '/admin';
  event.cookies.delete('wg_login_next', { path: '/' });
  redirect(303, next);
};
