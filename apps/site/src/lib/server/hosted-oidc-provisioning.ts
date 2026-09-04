import { ProfileCollection } from '@happyvertical/smrt-profiles';
import type {
  GetOrCreateFromOidcOptions,
  OidcClaims,
  OidcProfileOwnerAuthorizer,
  User,
} from '@happyvertical/smrt-users';
import type { OidcOwnerBinding } from './app-config.js';

export const hostedOidcProvider = 'keycloak';

export interface HostedOidcUserCollection {
  getOrCreateFromOidc: (
    claims: OidcClaims,
    provider: string,
    options?: GetOrCreateFromOidcOptions,
  ) => Promise<{ user: User }>;
}

function normalizedEmail(value: string | undefined): string {
  return value?.trim().toLowerCase() ?? '';
}

/**
 * Authorize only a migration-declared immutable issuer/subject binding. The
 * verified email is a second consistency check, never the authorization key:
 * that prevents an address alone from attaching a new IdP identity to an
 * imported, already-owned Profile.
 */
export function createImportedOwnerAuthorizer(
  bindings: readonly OidcOwnerBinding[],
): OidcProfileOwnerAuthorizer {
  return async ({ claims, db, users }) => {
    const binding = bindings.find(
      ({ issuer, subject }) => issuer === claims.iss && subject === claims.sub,
    );
    if (!binding || claims.email_verified !== true) return null;

    const user = await users.get({ id: binding.userId });
    if (
      user?.status !== 'active' ||
      !user?.profileId ||
      normalizedEmail(user?.email) !== normalizedEmail(claims.email)
    ) {
      return null;
    }

    const profiles = await ProfileCollection.create({ db });
    const profile = await profiles.get({ id: user.profileId });
    return profile ? { profile, user } : null;
  };
}

/**
 * Delegate hosted identity reconciliation to the released SMRT provisioning
 * contract. The contract is responsible for exact issuer/subject reuse,
 * canonical verified-email fallback, and transaction-safe ownership checks.
 */
export async function provisionHostedOidcUser(
  claims: OidcClaims,
  users: HostedOidcUserCollection,
  bindings: readonly OidcOwnerBinding[] = [],
): Promise<User> {
  const result = await users.getOrCreateFromOidc(claims, hostedOidcProvider, {
    authorizeProfileOwner: createImportedOwnerAuthorizer(bindings),
  });
  return result.user;
}
