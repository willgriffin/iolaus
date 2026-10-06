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
    // `undefined` preserves the released SMRT verified-email and existing
    // identity path. A matching binding that cannot be validated is an
    // explicit denial: it must never fall through to an email-only takeover.
    if (!binding) return undefined;
    if (claims.email_verified !== true) return null;

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
  const options =
    bindings.length === 0
      ? undefined
      : { authorizeProfileOwner: createImportedOwnerAuthorizer(bindings) };
  const result = await users.getOrCreateFromOidc(
    claims,
    hostedOidcProvider,
    options,
  );
  return result.user;
}

export const hostedMagicLinkProvider = 'magic-link';

/**
 * A verified magic link proves control of the mailbox, and the caller has
 * already required an active invitation for it. So an existing active User
 * with exactly that normalized email (for example one created by an earlier
 * OIDC sign-in) is the same person: reuse its Profile and workspace instead of
 * SMRT's default refusal to bind a new identity to an owned Profile. A User
 * that is inactive or has no Profile is denied; no match defers to SMRT.
 */
export function createMagicLinkOwnerAuthorizer(): OidcProfileOwnerAuthorizer {
  return async ({ claims, db, users }) => {
    const email = normalizedEmail(claims.email);
    const user = email ? await users.findByEmail(email) : null;
    if (!user) return undefined;
    if (user.status !== 'active' || !user.profileId) return null;
    if (normalizedEmail(user.email) !== email) return null;
    const profiles = await ProfileCollection.create({ db });
    const profile = await profiles.get({ id: user.profileId });
    return profile ? { profile, user } : null;
  };
}
/** Fixed issuer for identities proven by a delivered magic link. */
export const hostedMagicLinkIssuer = 'iolaus:magic-link';

/**
 * Provision the hosted user for an email proven by a verified, single-use
 * magic link. It goes through the same released SMRT provisioning contract as
 * hosted OIDC, so an existing User with that verified email is reused (an
 * earlier OIDC identity keeps its profile and workspace) and a new one gets
 * exactly one User and Profile. Possession of the mailbox is the verification,
 * so `email_verified` is asserted here and nowhere else.
 */
export async function provisionHostedMagicLinkUser(
  email: string,
  users: HostedOidcUserCollection,
): Promise<User> {
  const normalized = normalizedEmail(email);
  if (!normalized) throw new Error('A magic-link email is required.');
  const result = await users.getOrCreateFromOidc(
    {
      email: normalized,
      email_verified: true,
      iss: hostedMagicLinkIssuer,
      sub: normalized,
    } as OidcClaims,
    hostedMagicLinkProvider,
    { authorizeProfileOwner: createMagicLinkOwnerAuthorizer() },
  );
  return result.user;
}
