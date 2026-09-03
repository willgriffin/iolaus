import { randomUUID } from 'node:crypto';
import { getAuth, type TokenClaims } from '@happyvertical/auth';
import { resolveDatabase } from '@happyvertical/smrt-core';
import {
  DEFAULT_ROLE_SLUGS,
  MembershipCollection,
  MembershipStatus,
  type OidcClaims,
  RoleCollection,
  TenantCollection,
  TenantStatus,
  type User,
} from '@happyvertical/smrt-users';
import {
  createSessionCookie,
  destroySessionCookie,
} from '@happyvertical/smrt-users/sveltekit';
import { error, type RequestEvent, redirect } from '@sveltejs/kit';
import {
  getAppConfig,
  getAuthConfiguration,
  getConfiguredPublicOrigin,
  isLoopbackAddress,
  isLoopbackHostname,
} from './app-config.js';
import { getDbConfig, getSmrtOptions } from './db.js';

const appConfig = getAppConfig();
const oidcStateCookie = appConfig.oidcStateCookieName;
const oidcVerifierCookie = appConfig.oidcVerifierCookieName;
const oidcNonceCookie = appConfig.oidcNonceCookieName;

export const sessionCookieName = appConfig.sessionCookieName;
export const loginNextCookieName = appConfig.loginNextCookieName;
export const singleTenantSlug = appConfig.tenantSlug;
export const singleTenantName = appConfig.tenantName;

function isLocalhost(event: RequestEvent): boolean {
  if (!isLoopbackHostname(event.url.hostname)) return false;
  try {
    return isLoopbackAddress(event.getClientAddress());
  } catch {
    return false;
  }
}

export function canUseLocalDevLogin(event: RequestEvent): boolean {
  return getAuthConfiguration().kind === 'local' && isLocalhost(event);
}

function getBaseUrl(event: RequestEvent): string {
  return getConfiguredPublicOrigin() ?? event.url.origin;
}

function getRedirectUri(event: RequestEvent): string {
  return `${getBaseUrl(event)}/auth/oidc/callback`;
}

function secureCookie(event: RequestEvent): boolean {
  return event.url.protocol === 'https:';
}

function setTemporaryCookie(
  event: RequestEvent,
  name: string,
  value: string,
): void {
  event.cookies.set(name, value, {
    httpOnly: true,
    maxAge: 10 * 60,
    path: '/',
    sameSite: 'lax',
    secure: secureCookie(event),
  });
}

function deleteTemporaryCookie(event: RequestEvent, name: string): void {
  event.cookies.delete(name, { path: '/' });
}

export async function getOidcAuth(event: RequestEvent) {
  const configuration = getAuthConfiguration();
  if (configuration.kind !== 'self-hosted') {
    const message =
      configuration.kind === 'invalid'
        ? configuration.message
        : 'Iolaus local mode does not require OIDC authentication.';
    error(503, message);
  }

  return await getAuth({
    type: 'keycloak',
    serverUrl: configuration.oidc.serverUrl,
    realm: configuration.oidc.realm,
    clientId: configuration.oidc.clientId,
    clientSecret: configuration.oidc.clientSecret,
    redirectUri: getRedirectUri(event),
    scopes: ['openid', 'profile', 'email'],
    usePKCE: true,
  });
}

export async function startOidcLogin(event: RequestEvent): Promise<string> {
  const auth = await getOidcAuth(event);
  const state = crypto.randomUUID();
  const nonce = crypto.randomUUID();
  const result = await auth.getAuthorizationUrl({
    state,
    nonce,
    redirectUri: getRedirectUri(event),
    scopes: ['openid', 'profile', 'email'],
  });

  setTemporaryCookie(event, oidcStateCookie, result.state);
  setTemporaryCookie(event, oidcNonceCookie, result.nonce ?? nonce);
  if (result.codeVerifier) {
    setTemporaryCookie(event, oidcVerifierCookie, result.codeVerifier);
  }

  return result.url;
}

function readAndClearOauthCookies(event: RequestEvent) {
  const state = event.cookies.get(oidcStateCookie);
  const codeVerifier = event.cookies.get(oidcVerifierCookie);
  const nonce = event.cookies.get(oidcNonceCookie);

  deleteTemporaryCookie(event, oidcStateCookie);
  deleteTemporaryCookie(event, oidcVerifierCookie);
  deleteTemporaryCookie(event, oidcNonceCookie);

  return { state, codeVerifier, nonce };
}

export function tokenClaimsToOidcClaims(
  claims: TokenClaims,
): OidcClaims & { email_verified?: boolean } {
  return {
    sub: claims.sub,
    iss: claims.iss,
    email: claims.email,
    email_verified: claims.email_verified,
    name: claims.name,
    preferred_username: claims.preferred_username,
  };
}

function normalizeLoginEmail(email: string | undefined): string {
  return email?.trim().toLowerCase() ?? '';
}

export function isAuthorizedOidcAdmin(
  claims: Pick<TokenClaims, 'email' | 'email_verified'>,
  configuredEmails?: string,
): boolean {
  if (claims.email_verified !== true) return false;

  const email = normalizeLoginEmail(claims.email);
  if (!email) return false;

  const authConfiguration = getAuthConfiguration();
  const resolvedEmails =
    configuredEmails ??
    (authConfiguration.kind === 'self-hosted'
      ? authConfiguration.oidc.adminEmails.join(',')
      : undefined);

  const allowedEmails = new Set(
    (resolvedEmails ?? '')
      .split(',')
      .map((value: string) => normalizeLoginEmail(value))
      .filter(Boolean),
  );
  return allowedEmails.has(email);
}

function slugifyEmail(email: string): string {
  return email
    .replace(/@/gu, '-at-')
    .replace(/[^a-z0-9]+/giu, '-')
    .replace(/^-|-$/gu, '')
    .toLowerCase();
}

function userFromRow(row: Record<string, unknown>): User {
  return {
    email: String(row.email ?? ''),
    id: String(row.id ?? ''),
    lastLoginAt: row.last_login_at ? new Date(String(row.last_login_at)) : null,
    profileId: String(row.profile_id ?? ''),
    status: String(row.status ?? 'active'),
  } as User;
}

async function getOrCreateLoginUserFromClaims(
  claims: OidcClaims,
): Promise<User> {
  const email = normalizeLoginEmail(claims.email);
  if (!email) {
    error(400, 'OIDC claims missing required email.');
  }

  const db = await resolveDatabase(getDbConfig());
  const existing = (await db.single`
    SELECT id, email, status, last_login_at, profile_id
    FROM users
    WHERE lower(email) = ${email}
    LIMIT 1
  `) as Record<string, unknown> | null;

  if (existing) {
    await db.execute`
      UPDATE users
      SET last_login_at = current_timestamp, updated_at = current_timestamp
      WHERE id = ${String(existing.id)}
    `;
    return userFromRow({ ...existing, last_login_at: new Date() });
  }

  const id = randomUUID();
  await db.execute`
    INSERT INTO users (id, slug, context, email, status, last_login_at, profile_id)
    VALUES (${id}, ${slugifyEmail(email)}, ${''}, ${email}, ${'active'}, current_timestamp, ${''})
  `;

  return {
    email,
    id,
    lastLoginAt: new Date(),
    profileId: '',
    status: 'active',
  } as User;
}

async function ensureSingleTenantAccess(user: User) {
  const options = getSmrtOptions();
  const roles = await RoleCollection.create(options);
  const tenants = await TenantCollection.create(options);
  const memberships = await MembershipCollection.create(options);

  await roles.seedSystemRoles();

  let tenant = await tenants.findBySlug(singleTenantSlug);
  if (!tenant) {
    tenant = await tenants.create({
      name: singleTenantName,
      slug: singleTenantSlug,
      status: TenantStatus.ACTIVE,
      description: 'Single-tenant employment-search workspace.',
    });
    await tenant.save();
  }

  const adminRole =
    (await roles.findBySlug(DEFAULT_ROLE_SLUGS.ADMIN)) ??
    (await roles.findBySlug(DEFAULT_ROLE_SLUGS.OWNER));

  if (!adminRole?.id || !tenant.id || !user.id) {
    throw new Error(
      'Unable to resolve single-tenant membership prerequisites.',
    );
  }

  let membership = await memberships.findByUserAndTenant(user.id, tenant.id);
  if (!membership) {
    membership = await memberships.create({
      userId: user.id,
      tenantId: tenant.id,
      roleId: adminRole.id,
      status: MembershipStatus.ACTIVE,
    });
    await membership.save();
    return { tenant, membership };
  }

  membership.status = MembershipStatus.ACTIVE;
  membership.roleId = adminRole.id;
  await membership.save();
  return { tenant, membership };
}

async function createAdminSession(
  event: RequestEvent,
  user: User,
  tenantId: string,
  data?: Record<string, unknown>,
): Promise<void> {
  await createSessionCookie(
    event as unknown as Parameters<typeof createSessionCookie>[0],
    user.id as string,
    tenantId,
    {
      ...getSmrtOptions(),
      cookieName: sessionCookieName,
      cookieSecure: secureCookie(event),
      data,
      ipAddress: event.getClientAddress(),
      userAgent: event.request.headers.get('user-agent') ?? '',
    },
  );
}

export async function completeLocalDevLogin(
  event: RequestEvent,
): Promise<void> {
  if (!canUseLocalDevLogin(event)) {
    error(404, 'Not found');
  }

  const email = process.env.LOCAL_DEV_ADMIN_EMAIL ?? 'owner@example.invalid';
  const user = await getOrCreateLoginUserFromClaims({
    email,
    iss: 'local-dev',
    name: 'Local Development Admin',
    preferred_username: 'local-dev',
    sub: `local-dev:${email}`,
  });
  const { tenant } = await ensureSingleTenantAccess(user);

  await createAdminSession(event, user, tenant.id as string, {
    kind: 'local-dev',
  });
}

export async function completeOidcLogin(event: RequestEvent): Promise<void> {
  const callbackError = event.url.searchParams.get('error');
  if (callbackError) {
    error(
      400,
      event.url.searchParams.get('error_description') ?? callbackError,
    );
  }

  const code = event.url.searchParams.get('code');
  const callbackState = event.url.searchParams.get('state');
  const { state, codeVerifier, nonce } = readAndClearOauthCookies(event);

  if (!code || !callbackState || !state || callbackState !== state) {
    error(400, 'Invalid OIDC callback state');
  }

  const auth = await getOidcAuth(event);
  const tokens = await auth.exchangeCode({
    code,
    state,
    codeVerifier,
    redirectUri: getRedirectUri(event),
  });

  const claims = await auth.validateToken(
    tokens.idToken ?? tokens.accessToken,
    {
      nonce,
    },
  );

  if (!claims) {
    error(401, 'OIDC token validation failed');
  }

  if (!isAuthorizedOidcAdmin(claims)) {
    error(403, 'This account is not authorized to administer this site.');
  }

  const user = await getOrCreateLoginUserFromClaims(
    tokenClaimsToOidcClaims(claims),
  );

  const { tenant } = await ensureSingleTenantAccess(user);

  await createAdminSession(event, user, tenant.id as string);
}

export async function logout(event: RequestEvent): Promise<never> {
  await destroySessionCookie(
    event as unknown as Parameters<typeof destroySessionCookie>[0],
    {
      ...getSmrtOptions(),
      cookieName: sessionCookieName,
    },
  );
  redirect(303, '/');
}
