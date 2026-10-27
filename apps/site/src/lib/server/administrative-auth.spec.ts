import { execFileSync } from 'node:child_process';
import { withTenant } from '@happyvertical/smrt-tenancy';
import { afterEach, describe, expect, it } from 'vitest';
import {
  administrativeSessionFailure,
  isConfiguredOidcAdminEmail,
} from './administrative-auth';
import { getAuthConfiguration } from './app-config';
import { requireSourceCrawlOperator } from './source-crawl-operator';

const environmentNames = [
  'IOLAUS_OIDC_ADMIN_EMAILS',
  'IOLAUS_OIDC_CLIENT_ID',
  'IOLAUS_OIDC_REALM',
  'IOLAUS_OIDC_SERVER_URL',
  'IOLAUS_PUBLIC_URL',
  'SMRT_APP_ID',
  'SMRT_RUNTIME_PROFILE',
  'IOLAUS_AUTH_MODE',
  'IOLAUS_WORKSPACE_MODE',
  'SMTP_HOST',
  'SMTP_USER',
  'SMTP_PASSWORD',
  'SMTP_FROM',
  'IOLAUS_MAGIC_LINK_SECRET',
  'ADDRESS_HEADER',
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
    'magic-link',
    'oidc',
  ])('preserves shared %s operator revalidation through adoption Secret projection', async (authMode) => {
    // Exercise the CLI helpers in their Node runtime, then use the real auth guard.
    const projected: Record<string, string> = JSON.parse(
      execFileSync(
        process.execPath,
        [
          '--input-type=module',
          '-e',
          `
      import { actorSecretData, candidateRuntime, syntheticAuthContract } from './scripts/adoption-candidate.mjs';
      import { syntheticRuntimeValues } from './scripts/adoption-kind-fixture.mjs';
      const authMode=process.argv[1];
      const contract=authMode==='magic-link' ? syntheticAuthContract : {
        authMode,workspaceMode:'shared',oidcIssuerMode:'root',optionalOidcKeys:[]};
      const runtime=candidateRuntime({
        site:'ghcr.io/willgriffin/iolaus/site@sha256:'+'a'.repeat(64),
        extractor:'ghcr.io/willgriffin/iolaus/resume-import-extraction@sha256:'+'b'.repeat(64)},contract);
      const values={...syntheticRuntimeValues('a'.repeat(48)),
        DATABASE_URL:'postgresql://fixture:fixture@127.0.0.1/fixture',
        IOLAUS_AUTH_MODE:authMode,IOLAUS_OIDC_ADMIN_EMAILS:'owner@example.invalid',
        IOLAUS_OIDC_SERVER_URL:'https://identity.example.invalid',
        IOLAUS_OIDC_ISSUER_MODE:'root',IOLAUS_OIDC_CLIENT_ID:'fixture'};
      console.log(JSON.stringify(actorSecretData(runtime,values,'runtime')));
      `,
          authMode,
        ],
        { encoding: 'utf8', cwd: new URL('../../../../../', import.meta.url) },
      ),
    );
    for (const name of environmentNames) {
      if (projected[name] === undefined) delete process.env[name];
      else process.env[name] = projected[name];
    }
    expect(isConfiguredOidcAdminEmail(ownerSession.user.email)).toBe(true);
    await withTenant(
      { tenantId: 'tenant-1', userId: 'user-1', user: ownerSession.user },
      async () => {
        expect(() => requireSourceCrawlOperator()).not.toThrow();
        process.env.IOLAUS_OIDC_ADMIN_EMAILS = 'revoked@example.invalid';
        expect(isConfiguredOidcAdminEmail(ownerSession.user.email)).toBe(false);
        expect(() => requireSourceCrawlOperator()).toThrow(
          'active installation operator',
        );
      },
    );
  });
  it('permits the source worker operator without login mail settings and observes allowlist revocation', async () => {
    hostedEnvironment();
    process.env.IOLAUS_AUTH_MODE = 'magic-link';
    process.env.IOLAUS_WORKSPACE_MODE = 'shared';
    process.env.IOLAUS_MAGIC_LINK_SECRET =
      'test-only-worker-signing-secret-at-least-32-characters';
    process.env.ADDRESS_HEADER = 'X-Forwarded-For';
    Object.assign(process.env, {
      SMTP_HOST: 'smtp.example.invalid',
      SMTP_USER: 'fixture',
      SMTP_PASSWORD: 'fixture',
      SMTP_FROM: 'fixture@example.invalid',
    });
    expect(getAuthConfiguration().kind).toBe('magic-link');
    for (const name of ['SMTP_HOST', 'SMTP_USER', 'SMTP_PASSWORD', 'SMTP_FROM'])
      delete process.env[name];
    expect(getAuthConfiguration().kind).toBe('invalid');
    await withTenant(
      { tenantId: 'tenant-1', userId: 'user-1', user: ownerSession.user },
      async () => {
        expect(() => requireSourceCrawlOperator()).not.toThrow();
        for (const allowlist of [
          '',
          'not-an-email',
          'owner@example.invalid,invalid',
          'different@example.invalid',
        ]) {
          process.env.IOLAUS_OIDC_ADMIN_EMAILS = allowlist;
          expect(() => requireSourceCrawlOperator()).toThrow(
            'active installation operator',
          );
        }
      },
    );
  });
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
