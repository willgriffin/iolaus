import { json, type RequestHandler } from '@sveltejs/kit';
import { destroyBearerSession } from '$lib/server/terminal-auth';

function getBearerToken(authorization: string | null): string | null {
  const match = authorization?.match(/^Bearer\s+(.+)$/iu);
  return match?.[1]?.trim() || null;
}

export const GET: RequestHandler = async ({ locals }) => {
  if (!locals.user) {
    return json({ authenticated: false }, { status: 401 });
  }

  return json({
    authenticated: true,
    sessionId: locals.sessionId,
    tenantId: locals.tenantId,
    user: {
      email: locals.user.email,
      id: locals.user.id,
    },
  });
};

export const DELETE: RequestHandler = async ({ request }) => {
  const token = getBearerToken(request.headers.get('authorization'));
  if (token) {
    await destroyBearerSession(token);
  }

  return json({ authenticated: false });
};
