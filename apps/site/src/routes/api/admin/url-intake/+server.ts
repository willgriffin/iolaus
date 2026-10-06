import { error, json, type RequestHandler } from '@sveltejs/kit';
import {
  isOwnerAuthorityDenial,
  OwnerPrincipalError,
} from '$lib/server/owner-principal';
import { ingestPublicUrl } from '$lib/server/url-intake';

export const POST: RequestHandler = async ({ locals, request, url }) => {
  if (!locals.user)
    return json({ error: 'Sign in before adding a URL.' }, { status: 401 });
  if (
    request.headers.get('content-type')?.split(';')[0]?.trim() !==
    'application/json'
  )
    return json({ error: 'Send the URL as JSON.' }, { status: 415 });
  const origin = request.headers.get('origin');
  if (origin && origin !== url.origin)
    return json(
      { error: 'Use the Add URL form from this site.' },
      { status: 403 },
    );
  if (Number(request.headers.get('content-length')) > 4096)
    error(413, 'URL intake request is too large.');
  const raw = await request.text();
  if (raw.length > 4096) error(413, 'URL intake request is too large.');
  let input: Record<string, unknown>;
  try {
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== 'object' || Array.isArray(value))
      throw new Error();
    input = value as Record<string, unknown>;
    if (Object.keys(input).some((key) => !['url', 'kind'].includes(key)))
      throw new Error();
  } catch {
    return json(
      { error: 'Provide a URL and an optional opportunity/source choice.' },
      { status: 400 },
    );
  }
  try {
    return json(await ingestPublicUrl(input, locals));
  } catch (cause) {
    if (cause instanceof OwnerPrincipalError)
      return json({ error: 'Sign in before adding a URL.' }, { status: 401 });
    if (isOwnerAuthorityDenial(cause))
      return json(
        { error: 'You do not have permission to add this URL.' },
        { status: 403 },
      );
    const status =
      cause && typeof cause === 'object' && 'status' in cause
        ? Number(cause.status)
        : 400;
    return json(
      {
        error:
          cause instanceof Error ? cause.message : 'Unable to add this URL.',
      },
      { status: [400, 403, 404, 409, 503].includes(status) ? status : 400 },
    );
  }
};
