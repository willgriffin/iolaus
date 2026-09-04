import { json, type RequestHandler } from '@sveltejs/kit';
import { administrativeSessionFailure } from '$lib/server/administrative-auth';
import { listMcpTools } from '$lib/server/mcp';

export const GET: RequestHandler = async ({ locals }) => {
  const tools = await listMcpTools({
    authenticated: administrativeSessionFailure(locals) === null,
  });

  return json({ tools });
};
