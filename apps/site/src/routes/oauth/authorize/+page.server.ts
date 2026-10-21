import { randomBytes, timingSafeEqual } from 'node:crypto';
import { error, fail, redirect } from '@sveltejs/kit';
import {
  getLocalOAuth,
  oauthScopeDescriptions,
  oauthScopePermissions,
} from '$lib/server/local-oauth';
import type { Actions, PageServerLoad } from './$types';

const csrfCookie = 'iolaus_oauth_consent';
export const load: PageServerLoad = async (event) => {
  event.setHeaders({
    'cache-control': 'private, no-store',
    'referrer-policy': 'same-origin',
  });
  const oauth = await getLocalOAuth();
  if (!oauth) error(404, 'Not found');
  if (!event.locals.sessionId || !event.locals.user)
    redirect(
      303,
      `/login?next=${encodeURIComponent(event.url.pathname + event.url.search)}`,
    );
  await oauth.authorization.listGrants(event.locals.sessionId);
  let request;
  try {
    request = await oauth.server.parseAuthorizationRequest(
      event.url.searchParams,
    );
  } catch {
    error(400, 'Invalid authorization request.');
  }
  const csrf = randomBytes(32).toString('base64url');
  event.cookies.set(csrfCookie, csrf, {
    path: '/oauth/authorize',
    httpOnly: true,
    secure: true,
    sameSite: 'lax',
    maxAge: 600,
  });
  return {
    clientId: request.clientId,
    redirectUri: request.redirectUri,
    csrf,
    scopes: request.scopes.map((scope) => ({
      name: scope,
      description: oauthScopeDescriptions[scope],
      permitted:
        oauthScopePermissions[scope]?.every((permission) =>
          event.locals.permissions?.includes(permission),
        ) ?? false,
    })),
  };
};
export const actions: Actions = {
  default: async (event) => {
    event.setHeaders({ 'cache-control': 'private, no-store' });
    if (event.request.headers.get('origin') !== event.url.origin)
      error(403, 'Invalid consent origin.');
    const form = await event.request.formData();
    const expected = event.cookies.get(csrfCookie) ?? '';
    const actual = String(form.get('csrf') ?? '');
    if (
      !expected ||
      Buffer.byteLength(expected) !== Buffer.byteLength(actual) ||
      !timingSafeEqual(Buffer.from(expected), Buffer.from(actual))
    )
      error(403, 'Consent expired.');
    event.cookies.delete(csrfCookie, { path: '/oauth/authorize' });
    if (form.get('decision') !== 'approve') return fail(403, { denied: true });
    if (!event.locals.sessionId || !event.locals.user)
      error(401, 'Sign in required.');
    const oauth = await getLocalOAuth();
    if (!oauth) error(404, 'Not found');
    let destination;
    try {
      const request = await oauth.server.parseAuthorizationRequest(
        event.url.searchParams,
      );
      const selected = new Set(form.getAll('scope').map(String));
      const scopes = request.scopes.filter(
        (scope) =>
          selected.has(scope) &&
          oauthScopePermissions[scope]?.every((permission) =>
            event.locals.permissions?.includes(permission),
          ),
      );
      if (!scopes.length) return fail(403, { denied: true });
      destination = (
        await oauth.authorization.approve(
          oauth.server,
          { ...request, scopes },
          event.locals.sessionId,
        )
      ).redirectUri;
    } catch {
      return fail(403, { denied: true });
    }
    redirect(303, destination);
  },
};
