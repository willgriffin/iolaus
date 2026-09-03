import { afterEach, describe, expect, it } from 'vitest';
import {
  canUseLocalDevLogin,
  isAuthorizedOidcAdmin,
  tokenClaimsToOidcClaims,
} from './auth';

const originalClientId = process.env.IOLAUS_OIDC_CLIENT_ID;
const originalNodeEnv = process.env.NODE_ENV;

afterEach(() => {
  if (originalClientId === undefined) {
    delete process.env.IOLAUS_OIDC_CLIENT_ID;
  } else {
    process.env.IOLAUS_OIDC_CLIENT_ID = originalClientId;
  }

  if (originalNodeEnv === undefined) {
    delete process.env.NODE_ENV;
  } else {
    process.env.NODE_ENV = originalNodeEnv;
  }
});

function requestEventFor(url: string) {
  return { url: new URL(url) } as never;
}

describe('tokenClaimsToOidcClaims', () => {
  it('preserves verified-email claims for smrt-profiles account linking', () => {
    expect(
      tokenClaimsToOidcClaims({
        aud: 'iolaus-dev',
        email: 'will@example.com',
        email_verified: true,
        exp: 1,
        iat: 1,
        iss: 'https://identity.example.invalid/realms/happyvertical',
        name: 'Example Candidate',
        preferred_username: 'will',
        sub: 'subject-1',
      }),
    ).toEqual({
      email: 'will@example.com',
      email_verified: true,
      iss: 'https://identity.example.invalid/realms/happyvertical',
      name: 'Example Candidate',
      preferred_username: 'will',
      sub: 'subject-1',
    });
  });
});

describe('isAuthorizedOidcAdmin', () => {
  it('accepts a verified email from the configured allowlist', () => {
    expect(
      isAuthorizedOidcAdmin(
        { email: ' OWNER@EXAMPLE.INVALID ', email_verified: true },
        'other@example.com,owner@example.invalid',
      ),
    ).toBe(true);
  });

  it('rejects unverified, unlisted, and unconfigured identities', () => {
    expect(
      isAuthorizedOidcAdmin(
        { email: 'owner@example.invalid', email_verified: false },
        'owner@example.invalid',
      ),
    ).toBe(false);
    expect(
      isAuthorizedOidcAdmin(
        { email: 'other@example.com', email_verified: true },
        'owner@example.invalid',
      ),
    ).toBe(false);
    expect(
      isAuthorizedOidcAdmin(
        { email: 'owner@example.invalid', email_verified: true },
        undefined,
      ),
    ).toBe(false);
  });
});

describe('canUseLocalDevLogin', () => {
  it('allows localhost development login when OIDC is not configured', () => {
    delete process.env.IOLAUS_OIDC_CLIENT_ID;
    process.env.NODE_ENV = 'development';

    expect(
      canUseLocalDevLogin(requestEventFor('http://localhost:5173/login')),
    ).toBe(true);
  });

  it('does not allow the fallback outside local development', () => {
    delete process.env.IOLAUS_OIDC_CLIENT_ID;
    process.env.NODE_ENV = 'production';

    expect(
      canUseLocalDevLogin(requestEventFor('http://localhost:5173/login')),
    ).toBe(false);

    process.env.NODE_ENV = 'development';
    process.env.IOLAUS_OIDC_CLIENT_ID = 'client-id';

    expect(
      canUseLocalDevLogin(requestEventFor('http://localhost:5173/login')),
    ).toBe(false);
    expect(
      canUseLocalDevLogin(requestEventFor('https://iolaus.localhost/login')),
    ).toBe(false);
  });
});
