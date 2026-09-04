import { describe, expect, it } from 'vitest';
import {
  getAppConfig,
  getAuthConfiguration,
  getConfiguredMcpServerName,
  getConfiguredPublicOrigin,
  getConfiguredUserAgent,
  isLoopbackAddress,
  isLoopbackHostname,
} from './app-config';

describe('Iolaus application configuration', () => {
  it('uses a generic, collision-resistant local identity by default', () => {
    expect(getAppConfig({})).toMatchObject({
      agentClass: 'iolaus/owner',
      appId: 'iolaus',
      appMark: 'I',
      appName: 'Iolaus',
      cliConfigDirectory: 'iolaus',
      loginNextCookieName: 'iolaus_login_next',
      runtimeProfile: 'local',
      sessionCookieName: 'iolaus_session',
      tenantSlug: 'iolaus',
    });
    expect(getAuthConfiguration({})).toEqual({ kind: 'local' });
  });

  it('accepts a complete self-hosted OIDC configuration without source edits', () => {
    const environment = {
      IOLAUS_APP_NAME: 'My Career Hub',
      IOLAUS_OIDC_ADMIN_EMAILS: 'OWNER@example.com,second@example.com',
      IOLAUS_OIDC_CLIENT_ID: 'career-hub',
      IOLAUS_OIDC_REALM: 'career',
      IOLAUS_OIDC_SERVER_URL: 'https://identity.example.com/',
      IOLAUS_PUBLIC_URL: 'https://career.example.com',
      SMRT_APP_ID: 'career-hub',
      SMRT_RUNTIME_PROFILE: 'self-hosted',
    };

    expect(getAppConfig(environment)).toMatchObject({
      appId: 'career-hub',
      appMark: 'MC',
      appName: 'My Career Hub',
      sessionCookieName: 'career_hub_session',
      tenantSlug: 'career-hub',
    });
    expect(getConfiguredPublicOrigin(environment)).toBe(
      'https://career.example.com',
    );
    expect(getAuthConfiguration(environment)).toEqual({
      kind: 'self-hosted',
      oidc: {
        adminEmails: ['owner@example.com', 'second@example.com'],
        clientId: 'career-hub',
        clientSecret: undefined,
        realm: 'career',
        serverUrl: 'https://identity.example.com',
      },
    });
  });

  it('fails closed with a secret-safe recovery message for incomplete public auth', () => {
    const configuration = getAuthConfiguration({
      IOLAUS_APP_NAME: 'My Career Hub',
      IOLAUS_OIDC_CLIENT_SECRET: 'never-report-this',
      IOLAUS_PUBLIC_URL: 'https://career.example.com',
      SMRT_APP_ID: 'career-hub',
      SMRT_RUNTIME_PROFILE: 'self-hosted',
    });

    expect(configuration).toMatchObject({ kind: 'invalid' });
    if (configuration.kind === 'invalid') {
      expect(configuration.message).toContain('My Career Hub');
      expect(configuration.message).not.toContain('Iolaus');
      expect(configuration.message).not.toContain('never-report-this');
      expect(configuration.message).not.toContain('career.example.com');
    }
  });

  it('uses the same explicit public-auth boundary for a hosted cloud profile', () => {
    expect(
      getAuthConfiguration({
        SMRT_APP_ID: 'career-cloud',
        SMRT_RUNTIME_PROFILE: 'cloud',
      }),
    ).toMatchObject({ kind: 'invalid' });

    expect(
      getConfiguredPublicOrigin({
        IOLAUS_PUBLIC_URL: 'https://cloud.example.com',
        SMRT_APP_ID: 'career-cloud',
        SMRT_RUNTIME_PROFILE: 'cloud',
      }),
    ).toBe('https://cloud.example.com');
  });

  it('requires a unique non-default identity for public deployments', () => {
    expect(() => getAppConfig({ SMRT_RUNTIME_PROFILE: 'self-hosted' })).toThrow(
      /unique non-default identifier/u,
    );
    expect(() =>
      getAppConfig({
        SMRT_APP_ID: 'iolaus',
        SMRT_RUNTIME_PROFILE: 'cloud',
      }),
    ).toThrow(/unique non-default identifier/u);
  });

  it('rejects ambiguous or control-bearing OIDC settings', () => {
    const base = {
      IOLAUS_OIDC_ADMIN_EMAILS: 'owner@example.com',
      IOLAUS_OIDC_CLIENT_ID: 'career-hub',
      IOLAUS_OIDC_REALM: 'career',
      IOLAUS_OIDC_SERVER_URL: 'https://identity.example.com',
      IOLAUS_PUBLIC_URL: 'https://career.example.com',
      SMRT_APP_ID: 'career-hub',
      SMRT_RUNTIME_PROFILE: 'self-hosted',
    };

    expect(
      getAuthConfiguration({
        ...base,
        IOLAUS_PUBLIC_URL: 'https://career.example.com/path',
      }),
    ).toMatchObject({ kind: 'invalid' });
    expect(
      getAuthConfiguration({
        ...base,
        IOLAUS_OIDC_SERVER_URL: 'https://identity.example.com?issuer=other',
      }),
    ).toMatchObject({ kind: 'invalid' });
    expect(
      getAuthConfiguration({
        ...base,
        IOLAUS_OIDC_REALM: 'career\nother',
      }),
    ).toMatchObject({ kind: 'invalid' });
    expect(
      getAuthConfiguration({
        ...base,
        IOLAUS_OIDC_CLIENT_ID: 'career\u0085other',
      }),
    ).toMatchObject({ kind: 'invalid' });
    expect(
      getAuthConfiguration({
        ...base,
        IOLAUS_OIDC_REALM: '../other',
      }),
    ).toMatchObject({ kind: 'invalid' });
    expect(
      getAuthConfiguration({
        ...base,
        IOLAUS_OIDC_CLIENT_ID: 'career\u202Eother',
      }),
    ).toMatchObject({ kind: 'invalid' });
  });

  it('recognizes only loopback hosts for local-only paths', () => {
    expect(isLoopbackHostname('localhost')).toBe(true);
    expect(isLoopbackHostname('127.0.0.1')).toBe(true);
    expect(isLoopbackHostname('career.example.com')).toBe(false);
    expect(isLoopbackAddress('::ffff:127.0.0.1')).toBe(true);
    expect(isLoopbackAddress('203.0.113.8')).toBe(false);
  });

  it('uses the configured product identity in outbound labels', () => {
    expect(
      getConfiguredUserAgent('source crawler', {
        IOLAUS_APP_NAME: 'My Career Hub',
      }),
    ).toBe('My Career Hub source crawler');
    expect(getConfiguredMcpServerName({ SMRT_APP_ID: 'career-hub' })).toBe(
      'career-hub-agent-employment-search',
    );
    expect(getConfiguredMcpServerName({})).not.toBe('iolaus-employment-search');
  });

  it('uses an ASCII-only header label while preserving a Unicode display name', () => {
    const userAgent = getConfiguredUserAgent('source crawler', {
      IOLAUS_APP_NAME: 'Career 🚀',
      SMRT_APP_ID: 'career-hub',
    });

    expect(userAgent).toBe('Career source crawler');
    expect(() => new Headers({ 'user-agent': userAgent })).not.toThrow();
  });
});
