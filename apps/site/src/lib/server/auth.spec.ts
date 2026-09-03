import { afterEach, describe, expect, it } from 'vitest';
import {
  canUseLocalDevLogin,
  getRuntimeCookieName,
  isAuthorizedOidcAdmin,
  tenantSlugsFor,
  tokenClaimsToOidcClaims,
} from './auth';

const authEnvNames = [
  'IOLAUS_OIDC_ADMIN_EMAILS',
  'IOLAUS_OIDC_CLIENT_ID',
  'IOLAUS_OIDC_REALM',
  'IOLAUS_OIDC_SERVER_URL',
  'IOLAUS_PUBLIC_URL',
  'SMRT_RUNTIME_PROFILE',
] as const;
const originalEnvironment = Object.fromEntries(
  authEnvNames.map((name) => [name, process.env[name]]),
);

afterEach(() => {
  for (const name of authEnvNames) {
    const original = originalEnvironment[name];
    if (original === undefined) delete process.env[name];
    else process.env[name] = original;
  }
});

function requestEventFor(url: string, clientAddress = '127.0.0.1') {
  return { getClientAddress: () => clientAddress, url: new URL(url) } as never;
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
  it('allows loopback local login without OIDC, including a production build', () => {
    process.env.SMRT_RUNTIME_PROFILE = 'local';

    expect(
      canUseLocalDevLogin(requestEventFor('http://localhost:5173/login')),
    ).toBe(true);
    expect(
      canUseLocalDevLogin(requestEventFor('http://[::1]:5173/login', '::1')),
    ).toBe(true);
  });

  it('does not allow the fallback for a public deployment', () => {
    process.env.SMRT_RUNTIME_PROFILE = 'self-hosted';
    process.env.IOLAUS_PUBLIC_URL = 'https://iolaus.example.com';
    process.env.IOLAUS_OIDC_SERVER_URL = 'https://identity.example.com';
    process.env.IOLAUS_OIDC_REALM = 'iolaus';
    process.env.IOLAUS_OIDC_CLIENT_ID = 'iolaus';
    process.env.IOLAUS_OIDC_ADMIN_EMAILS = 'owner@example.com';

    expect(
      canUseLocalDevLogin(requestEventFor('http://localhost:5173/login')),
    ).toBe(false);
    expect(
      canUseLocalDevLogin(requestEventFor('https://iolaus.localhost/login')),
    ).toBe(false);
  });

  it('refuses a forged loopback host header from a remote peer', () => {
    process.env.SMRT_RUNTIME_PROFILE = 'local';

    expect(
      canUseLocalDevLogin(
        requestEventFor('http://localhost:5173/login', '203.0.113.8'),
      ),
    ).toBe(false);
  });
});

describe('getRuntimeCookieName', () => {
  it('isolates local browser cookies by runtime configuration', () => {
    expect(
      getRuntimeCookieName(
        'iolaus_session',
        'local',
        '4e90ec8f9d9b0123456789abcdef',
      ),
    ).toBe('iolaus_session_4e90ec8f9d9b');
    expect(
      getRuntimeCookieName(
        'iolaus_session',
        'local',
        '6709d982e1890123456789abcdef',
      ),
    ).toBe('iolaus_session_6709d982e189');
  });

  it('keeps public cookies stable on their configured origin', () => {
    expect(
      getRuntimeCookieName('career_hub_session', 'self-hosted', 'ignored'),
    ).toBe('career_hub_session');
  });
});

describe('tenantSlugsFor', () => {
  it('reads legacy local data without creating a legacy tenant for new installs', () => {
    expect(tenantSlugsFor('iolaus')).toEqual(['iolaus', 'iolaus.localhost']);
    expect(tenantSlugsFor('career-hub')).toEqual(['career-hub']);
  });
});
