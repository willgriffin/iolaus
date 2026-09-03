import { describe, expect, it } from 'vitest';
import {
  getAppConfig,
  getAuthConfiguration,
  getConfiguredPublicOrigin,
  isLoopbackHostname,
} from './app-config';

describe('Iolaus application configuration', () => {
  it('uses a generic, collision-resistant local identity by default', () => {
    expect(getAppConfig({})).toMatchObject({
      agentClass: 'iolaus/owner',
      appId: 'iolaus',
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
      IOLAUS_PUBLIC_URL: 'https://career.example.com/path',
      SMRT_APP_ID: 'career-hub',
      SMRT_RUNTIME_PROFILE: 'self-hosted',
    };

    expect(getAppConfig(environment)).toMatchObject({
      appId: 'career-hub',
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
      IOLAUS_OIDC_CLIENT_SECRET: 'never-report-this',
      IOLAUS_PUBLIC_URL: 'https://career.example.com',
      SMRT_RUNTIME_PROFILE: 'self-hosted',
    });

    expect(configuration).toMatchObject({ kind: 'invalid' });
    if (configuration.kind === 'invalid') {
      expect(configuration.message).not.toContain('never-report-this');
      expect(configuration.message).not.toContain('career.example.com');
    }
  });

  it('recognizes only loopback hosts for local-only paths', () => {
    expect(isLoopbackHostname('localhost')).toBe(true);
    expect(isLoopbackHostname('127.0.0.1')).toBe(true);
    expect(isLoopbackHostname('career.example.com')).toBe(false);
  });
});
