import { getAppConfig, getAuthConfiguration } from './app-config.js';

type AdministrativeUser = {
  email?: string | null;
  id?: string | null;
  status?: string | null;
};

type AdministrativeMembership = {
  roleId?: string | null;
  status?: string | null;
  tenantId?: string | null;
  userId?: string | null;
};

export interface AdministrativeSession {
  membership?: AdministrativeMembership | null;
  permissions?: readonly string[] | null;
  tenantId?: string | null;
  user?: AdministrativeUser | null;
}

export type AdministrativeSessionFailure = 'forbidden' | 'unauthenticated';

function normalizedEmail(value: string | null | undefined): string {
  return value?.trim().toLowerCase() ?? '';
}

/**
 * Match an already-authenticated hosted user to the configured OIDC admin
 * allowlist. This intentionally checks the current configuration on every
 * protected request, so removing an operator from the allowlist also revokes
 * pre-existing browser and CLI sessions at their next use.
 */
export function isConfiguredOidcAdminEmail(
  email: string | null | undefined,
): boolean {
  const configuration = getAuthConfiguration();
  if (configuration.kind !== 'self-hosted') return false;

  const candidate = normalizedEmail(email);
  return (
    Boolean(candidate) && configuration.oidc.adminEmails.includes(candidate)
  );
}

/**
 * Iolaus has one private owner workspace. A session therefore needs a real,
 * active tenant membership with a role as well as the ordinary session user.
 * The request-specific permission resolver remains the authority for each
 * individual operation; this boundary keeps an arbitrary authenticated user
 * out of the private administrative surfaces before a route can disclose data.
 */
export function administrativeSessionFailure(
  session: AdministrativeSession,
): AdministrativeSessionFailure | null {
  const userId = session.user?.id?.trim() ?? '';
  if (!userId) return 'unauthenticated';

  const tenantId = session.tenantId?.trim() ?? '';
  const membership = session.membership;
  if (
    !tenantId ||
    !membership ||
    membership.status !== 'active' ||
    membership.userId !== userId ||
    membership.tenantId !== tenantId ||
    !membership.roleId?.trim() ||
    !session.permissions?.length
  ) {
    return 'forbidden';
  }

  if (session.user?.status && session.user.status !== 'active') {
    return 'forbidden';
  }

  // Local installation has a single loopback-only owner created by the local
  // bootstrap. Every remotely reachable profile is instead bound to the OIDC
  // allowlist above; it never inherits local bootstrap authority.
  if (getAppConfig().runtimeProfile === 'local') return null;
  return isConfiguredOidcAdminEmail(session.user?.email) ? null : 'forbidden';
}
