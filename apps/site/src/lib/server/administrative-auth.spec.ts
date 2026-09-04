import { afterEach, describe, expect, it } from 'vitest';
import {
  administrativeSessionFailure,
  isConfiguredOidcAdminEmail,
} from './administrative-auth';

const environmentNames = [
  'IOLAUS_OIDC_ADMIN_EMAILS',
  'IOLAUS_OIDC_CLIENT_ID',
  'IOLAUS_OIDC_REALM',
  'IOLAUS_OIDC_SERVER_URL',
  'IOLAUS_PUBLIC_URL',
  'SMRT_APP_ID',
  'SMRT_RUNTIME_PROFILE',
] as const;
const originalEnvironment = Object.fromEntries(
  environmentNames.map((name) => [name, process.env[name]]),
);

afterEach(() => {
  for (const name of environmentNames) {
    const original = originalEnvironment[name];
    if (original === undefined) delete process.env[name];
    else process.env[name] = original;
  }
});

function hostedEnvironment() {
  Object.assign(process.env, {
    IOLAUS_OIDC_ADMIN_EMAILS: 'owner@example.invalid',
    IOLAUS_OIDC_CLIENT_ID: 'iolaus-self-hosted',
    IOLAUS_OIDC_REALM: 'career',
    IOLAUS_OIDC_SERVER_URL: 'https://identity.example.invalid',
    IOLAUS_PUBLIC_URL: 'https://iolaus.example.invalid',
    SMRT_APP_ID: 'iolaus-career',
    SMRT_RUNTIME_PROFILE: 'self-hosted',
  });
}

const ownerSession = {
  membership: {
    roleId: 'admin-role',
    status: 'active',
    tenantId: 'tenant-1',
    userId: 'user-1',
  },
  permissions: ['opportunities.read'],
  tenantId: 'tenant-1',
  user: {
    email: 'owner@example.invalid',
    id: 'user-1',
    status: 'active',
  },
};

describe('private administrative authorization matrix', () => {
  it.each([
    'ui',
    'rest',
    'mcp',
    'webmcp',
    'asset',
  ])('rejects unauthenticated %s access', (_surface) => {
    expect(administrativeSessionFailure({})).toBe('unauthenticated');
  });

  it.each([
    'ui',
    'rest',
    'mcp',
    'webmcp',
    'asset',
  ])('rejects an authenticated non-admin from %s access', (_surface) => {
    hostedEnvironment();
    expect(
      administrativeSessionFailure({
        ...ownerSession,
        user: { ...ownerSession.user, email: 'member@example.invalid' },
      }),
    ).toBe('forbidden');
  });

  it.each([
    'ui',
    'rest',
    'mcp',
    'webmcp',
    'asset',
  ])('admits an allowlisted active owner/admin to %s authorization', (_surface) => {
    hostedEnvironment();
    expect(administrativeSessionFailure(ownerSession)).toBeNull();
  });

  it('requires the user, tenant, active membership, role, and permission snapshot', () => {
    hostedEnvironment();
    for (const session of [
      { ...ownerSession, membership: null },
      { ...ownerSession, permissions: [] },
      {
        ...ownerSession,
        membership: { ...ownerSession.membership, status: 'pending' },
      },
      {
        ...ownerSession,
        membership: { ...ownerSession.membership, roleId: '' },
      },
      {
        ...ownerSession,
        membership: { ...ownerSession.membership, tenantId: 'tenant-2' },
      },
    ]) {
      expect(administrativeSessionFailure(session)).toBe('forbidden');
    }
  });

  it('normalizes an allowlisted hosted email but never authorizes it locally', () => {
    hostedEnvironment();
    expect(isConfiguredOidcAdminEmail(' OWNER@EXAMPLE.INVALID ')).toBe(true);
    process.env.SMRT_RUNTIME_PROFILE = 'local';
    expect(isConfiguredOidcAdminEmail('owner@example.invalid')).toBe(false);
  });
});
