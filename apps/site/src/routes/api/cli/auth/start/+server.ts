import { json, type RequestHandler } from '@sveltejs/kit';
import { createCliAuthRequest } from '$lib/server/terminal-auth';

export const POST: RequestHandler = async ({ url }) => {
  const authRequest = await createCliAuthRequest(url.origin);

  return json(authRequest, { status: 201 });
};
