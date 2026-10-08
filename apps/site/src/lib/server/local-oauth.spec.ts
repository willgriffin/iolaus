import { exportJWK, generateKeyPair } from 'jose';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ storage: vi.fn(), authorization: vi.fn() }));
vi.mock('@happyvertical/smrt-users', () => ({
  SmrtOAuthAuthorizationStorage: { create: mocks.storage },
  SmrtOAuthAuthorizationService: { create: mocks.authorization },
}));
vi.mock('./app-config.js', () => ({
  getConfiguredPublicOrigin: (environment: NodeJS.ProcessEnv) =>
    environment.IOLAUS_PUBLIC_URL ?? null,
}));
vi.mock('./db.js', () => ({ getSmrtOptions: () => ({}) }));

import {
  createLocalOAuth,
  localOAuthConfiguration,
  oauthScopePermissions,
} from './local-oauth';

beforeEach(() => {
  mocks.storage.mockResolvedValue({});
  mocks.authorization.mockResolvedValue({ identity: {} });
});
describe('local OAuth signing configuration', () => {
  it('is disabled by default and fails closed for incomplete enabled configuration', () => {
    expect(localOAuthConfiguration({})).toBeNull();
    expect(() =>
      localOAuthConfiguration({ IOLAUS_MCP_LOCAL_OAUTH_ENABLED: 'true' }),
    ).toThrow('HTTPS');
    expect(() =>
      localOAuthConfiguration({
        IOLAUS_MCP_LOCAL_OAUTH_ENABLED: 'true',
        IOLAUS_PUBLIC_URL: 'https://jobs.test',
      }),
    ).toThrow('incomplete');
  });
  it('publishes only public ES256 material and exact issuer/resource metadata', async () => {
    const { privateKey } = await generateKeyPair('ES256', {
      extractable: true,
    });
    const jwk = await exportJWK(privateKey);
    const oauth = await createLocalOAuth(
      {
        IOLAUS_MCP_LOCAL_OAUTH_ENABLED: 'true',
        IOLAUS_PUBLIC_URL: 'https://jobs.test',
        IOLAUS_MCP_OAUTH_KEY_ID: 'test-key',
        IOLAUS_MCP_OAUTH_PRIVATE_JWK: JSON.stringify(jwk),
      },
      {},
    );
    expect(oauth?.server.discovery()).toMatchObject({
      issuer: 'https://jobs.test/oauth',
      authorization_endpoint: 'https://jobs.test/oauth/authorize',
      token_endpoint: 'https://jobs.test/oauth/token',
    });
    expect(oauth?.resource).toBe('https://jobs.test/api/mcp');
    expect(oauth?.server.jwks().keys[0]).toEqual({
      kty: 'EC',
      crv: 'P-256',
      x: jwk.x,
      y: jwk.y,
      kid: 'test-key',
      alg: 'ES256',
      use: 'sig',
    });
    expect(JSON.stringify(oauth?.server.jwks())).not.toContain(jwk.d);
    expect(oauthScopePermissions['applications:prepare']).not.toContain(
      'workflow.application.review',
    );
    expect(oauthScopePermissions['applications:prepare']).not.toContain(
      'workflow.application-auto-submit.execute',
    );
  });
  it('rejects malformed signing keys without exposing their values', async () => {
    await expect(
      createLocalOAuth(
        {
          IOLAUS_MCP_LOCAL_OAUTH_ENABLED: 'true',
          IOLAUS_PUBLIC_URL: 'https://jobs.test',
          IOLAUS_MCP_OAUTH_KEY_ID: 'test-key',
          IOLAUS_MCP_OAUTH_PRIVATE_JWK: 'private-not-json',
        },
        {},
      ),
    ).rejects.toThrow('Invalid OAuth signing key.');
  });
});
