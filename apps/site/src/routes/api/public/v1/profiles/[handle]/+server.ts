import { publicProfileApiResponse } from '$lib/server/public-profile-api';
import { publicProfileApiHeaders } from '$lib/server/public-profile-api-transport';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = ({ params }) =>
  publicProfileApiResponse(params.handle);
export const HEAD: RequestHandler = async (event) => {
  const response = await GET(event);
  return new Response(null, {
    status: response.status,
    headers: response.headers,
  });
};
export const OPTIONS: RequestHandler = () =>
  new Response(null, {
    status: 204,
    headers: publicProfileApiHeaders,
  });
