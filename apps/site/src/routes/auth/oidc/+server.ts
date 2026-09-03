import { redirect } from '@sveltejs/kit';
import { startOidcLogin } from '$lib/server/auth';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async (event) => {
  redirect(303, await startOidcLogin(event));
};
