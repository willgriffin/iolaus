import { json, type RequestHandler } from '@sveltejs/kit';
import { callMcpTool, McpAccessError } from '$lib/server/mcp';

function jsonObjectPayload(payload: unknown): Record<string, unknown> {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new McpAccessError(400, 'Request body must be a JSON object.');
  }
  return payload as Record<string, unknown>;
}

async function readJsonObjectPayload(
  request: Request,
): Promise<Record<string, unknown>> {
  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    throw new McpAccessError(400, 'Request body must be valid JSON.');
  }
  return jsonObjectPayload(payload);
}

export const POST: RequestHandler = async ({ locals, request }) => {
  try {
    const body = await readJsonObjectPayload(request);
    const name = typeof body.name === 'string' ? body.name.trim() : '';
    if (!name) {
      return json({ error: 'name is required.' }, { status: 400 });
    }

    return json(
      await callMcpTool({
        arguments: body.arguments,
        name,
        permissions: locals.permissions,
        tenantId: locals.tenantId,
        user: locals.user ?? null,
      }),
    );
  } catch (error) {
    if (error instanceof McpAccessError) {
      return json({ error: error.message }, { status: error.status });
    }

    throw error;
  }
};
