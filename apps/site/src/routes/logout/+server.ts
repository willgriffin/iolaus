import { logout } from '$lib/server/auth';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async (event) => {
  return await logout(event);
};

export const POST: RequestHandler = async (event) => {
  return await logout(event);
};
