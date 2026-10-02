import type { McpAppPrincipal } from '@happyvertical/smrt-app-mcp';
import {
  createMcpResourceAuth,
  type McpResourceAuth,
  type McpVerifiedIdentity,
} from '@happyvertical/smrt-app-mcp/auth';
import { resolveDatabase } from '@happyvertical/smrt-core';
import { withPrincipalPermissionContext } from '@happyvertical/smrt-users';
import {
  getAppConfig,
  getAuthConfiguration,
  getConfiguredPublicOrigin,
} from './app-config.js';
import { getDbConfig, getSmrtOptions } from './db.js';
import { verifyWorkspaceSubject } from './workspace-subject.js';

const OAUTH_JWKS_URI = 'IOLAUS_MCP_OAUTH_JWKS_URI';
const OAUTH_SCOPES = 'IOLAUS_MCP_OAUTH_SCOPES';
const OAUTH_ALGORITHMS = 'IOLAUS_MCP_OAUTH_ALGORITHMS';
const OAUTH_TOKEN_TYPE = 'IOLAUS_MCP_OAUTH_TOKEN_TYPE';
const oauthBearerPattern =
  /^Bearer +[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/iu;

export type McpOauthConfiguration = {
  algorithms: Array<'ES256' | 'RS256'>;
  issuer: string;
  jwksUri: string;
  resource: string;
  scopes: string[];
  tokenType: 'JWT' | 'at+jwt';
};

type IdentityRow = {
  id?: unknown;
  profile_id?: unknown;
  status?: unknown;
};

type MembershipRow = {
  role_id?: unknown;
  status?: unknown;
  tenant_id?: unknown;
  tenant_slug?: unknown;
  tenant_status?: unknown;
};

type OAuthDatabase = {
  query: (
    statement: string,
    values: readonly string[],
  ) => Promise<{ rows: unknown[] }>;
};

type McpRouteEvent = {
  locals?: Record<string, unknown>;
  request: Request;
  url: URL;
};

function configuredString(value: string | undefined): string {
  return value?.trim() ?? '';
}

function exactHttpsUrl(value: string): string | null {
  try {
    const url = new URL(value);
    if (
      url.protocol !== 'https:' ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      value !== url.toString()
    ) {
      return null;
    }
    return url.toString();
  } catch {
    return null;
  }
}

function requiredIdentifier(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim();
  return normalized && normalized === value ? normalized : null;
}

/**
 * OAuth is opt-in. An incomplete deployment configuration never publishes
 * discovery metadata and cannot accidentally weaken the cookie/CLI boundary.
 */
export function getMcpOauthConfiguration(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): McpOauthConfiguration | null {
  const auth = getAuthConfiguration(environment);
  const origin = getConfiguredPublicOrigin(environment);
  if (auth.kind !== 'self-hosted' || !origin) return null;

  const jwksUri = exactHttpsUrl(configuredString(environment[OAUTH_JWKS_URI]));
  const scopes = configuredString(environment[OAUTH_SCOPES])
    .split(/\s+/u)
    .filter(Boolean);
  const algorithmInputs = configuredString(environment[OAUTH_ALGORITHMS])
    .split(',')
    .map((value) => value.trim());
  const algorithms = algorithmInputs.filter(
    (value): value is 'ES256' | 'RS256' =>
      value === 'ES256' || value === 'RS256',
  );
  const tokenType = configuredString(environment[OAUTH_TOKEN_TYPE]) || 'at+jwt';

  if (
    !jwksUri ||
    scopes.length === 0 ||
    scopes.some((scope) => !/^[\x21\x23-\x5b\x5d-\x7e]+$/u.test(scope)) ||
    algorithmInputs.length === 0 ||
    algorithms.length !== algorithmInputs.length ||
    algorithms.length !== new Set(algorithms).size ||
    (tokenType !== 'at+jwt' && tokenType !== 'JWT')
  ) {
    return null;
  }

  return {
    algorithms,
    issuer: auth.oidc.issuer,
    jwksUri,
    resource: new URL('/api/mcp', origin).toString(),
    scopes: [...new Set(scopes)],
    tokenType,
  };
}

/**
 * Resolve only a previously provisioned identity. OIDC JWT claims authenticate
 * the caller but never supply an Iolaus user, tenant, or profile selector.
 */
export function createMcpOauthPrincipalResolver(
  options: {
    getAppConfig?: typeof getAppConfig;
    resolveDatabase?: () => Promise<OAuthDatabase>;
  } = {},
): (
  identity: McpVerifiedIdentity,
) => Promise<{ id: string; tenantId: string } | null> {
  const resolveTrustedDatabase =
    options.resolveDatabase ??
    (async () => (await resolveDatabase(getDbConfig())) as OAuthDatabase);
  const configuredApp = options.getAppConfig ?? getAppConfig;
  return async (identity) => {
    const database = await resolveTrustedDatabase();
    const identities = await database.query(
      `SELECT users.id, users.profile_id, users.status
     FROM oidc_identities
     INNER JOIN users ON users.profile_id = oidc_identities.profile_id
     WHERE oidc_identities.issuer = ? AND oidc_identities.subject = ?
     LIMIT 2`,
      [identity.issuer, identity.subject],
    );
    const rows = identities.rows as IdentityRow[];
    if (rows.length !== 1 || rows[0]?.status !== 'active') return null;
    const userId = requiredIdentifier(rows[0]?.id);
    const profileId = requiredIdentifier(rows[0]?.profile_id);
    if (!userId || !profileId) return null;

    const app = configuredApp();
    const privateWorkspace = app.workspaceMode === 'private';
    const memberships = await database.query(
      `SELECT memberships.tenant_id, memberships.status, memberships.role_id,
            tenants.slug AS tenant_slug, tenants.status AS tenant_status
     FROM memberships
     INNER JOIN tenants ON tenants.id = memberships.tenant_id
     WHERE memberships.user_id = ?
       AND memberships.status = 'active'
       AND tenants.status = 'active'
       ${privateWorkspace ? 'AND tenants.slug = ?' : ''}
     LIMIT 2`,
      privateWorkspace ? [userId, app.tenantSlug] : [userId],
    );
    const membershipRows = memberships.rows as MembershipRow[];
    if (
      membershipRows.length !== 1 ||
      membershipRows[0]?.status !== 'active' ||
      membershipRows[0]?.tenant_status !== 'active' ||
      !requiredIdentifier(membershipRows[0]?.role_id)
    ) {
      return null;
    }
    const tenantId = requiredIdentifier(membershipRows[0]?.tenant_id);
    return tenantId ? { id: userId, tenantId } : null;
  };
}

export const resolveMcpOauthPrincipal = createMcpOauthPrincipalResolver();

/** Return the public adapter only when every OAuth deployment value is valid. */
export function createMcpOauthResourceAuth(
  configuration: McpOauthConfiguration,
  resolvePrincipal: (
    identity: McpVerifiedIdentity,
  ) => Promise<{ id: string; tenantId: string } | null>,
): McpResourceAuth {
  return createMcpResourceAuth({
    ...configuration,
    profile: 'self-hosted',
    requireTenant: true,
    resolvePrincipal,
  });
}

export function createIolausMcpResourceAuth(): McpResourceAuth | null {
  const configuration = getMcpOauthConfiguration();
  return configuration
    ? createMcpOauthResourceAuth(configuration, resolveMcpOauthPrincipal)
    : null;
}

/** OAuth uses three JWT segments; opaque CLI session tokens retain their route. */
export function isMcpOauthBearerRequest(request: Request): boolean {
  return oauthBearerPattern.test(request.headers.get('authorization') ?? '');
}

/**
 * Enter SMRT's public principal/tenant context from the adapter's verified
 * mapping, then rebuild the same live workspace subject used by cookie and CLI
 * requests. The resource adapter has already verified issuer, audience, JWT
 * type, signature, expiry, scope, and token subject.
 */
export async function withMcpOauthContext<T>(
  event: McpRouteEvent,
  principal: McpAppPrincipal & { id: string },
  execute: (event: McpRouteEvent) => Promise<T>,
): Promise<T | Response> {
  const userId = requiredIdentifier(principal.id);
  const tenantId = requiredIdentifier(principal.tenantId);
  if (!userId || !tenantId) return new Response(null, { status: 401 });
  return await withPrincipalPermissionContext(
    {
      ...getSmrtOptions(),
      enterTenantContext: true,
      tenantId,
      userId,
    },
    async (context) => {
      if (!context.user || !context.tenantId || !context.membership) {
        return new Response(null, { status: 401 });
      }
      const locals = {
        ...event.locals,
        membership: context.membership,
        permissions: context.permissions,
        tenantId: context.tenantId,
        user: context.user,
      } as App.Locals;
      if (!(await verifyWorkspaceSubject(locals))) {
        return new Response(null, { status: 401 });
      }
      return await execute({
        ...event,
        locals: locals as unknown as Record<string, unknown>,
      });
    },
  );
}
