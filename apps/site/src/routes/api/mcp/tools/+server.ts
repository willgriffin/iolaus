import { json, type RequestHandler } from '@sveltejs/kit';
import { listMcpTools } from '$lib/server/mcp';

export const GET: RequestHandler = async ({ locals }) => {
  const tools = await listMcpTools({ authenticated: Boolean(locals.user) });

  return json({ tools });
};
