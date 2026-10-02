import { generateKeyPairSync, type KeyObject, sign } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createMcpOauthResourceAuth,
  getMcpOauthConfiguration,
  isMcpOauthBearerRequest,
} from './mcp-oauth.js';

const resource = 'https://jobs.example.com/api/mcp';
const issuer = 'https://identity.example.com/realms/career';
const jwksUri = `${issuer}/protocol/openid-connect/certs`;

function base64url(value: string | Buffer): string {
  return Buffer.from(value).toString('base64url');
}

function tokenAndJwk(
  options: { audience?: string; privateKey?: KeyObject; scope?: string } = {},
) {
  const generated = options.privateKey
    ? null
    : generateKeyPairSync('rsa', { modulusLength: 2048 });
  const privateKey = options.privateKey ?? generated!.privateKey;
  const publicKey = generated?.publicKey;
  const header = base64url(JSON.stringify({ alg: 'RS256', typ: 'at+jwt' }));
  const payload = base64url(
    JSON.stringify({
      aud: options.audience ?? resource,
      exp: Math.floor(Date.now() / 1000) + 60,
      iss: issuer,
      scope: options.scope ?? 'iolaus.mcp',
      sub: 'oidc-subject-1',
    }),
  );
  const signature = sign(
    'RSA-SHA256',
    Buffer.from(`${header}.${payload}`),
    privateKey,
  ).toString('base64url');
  return {
    jwk: publicKey
      ? {
          ...publicKey.export({ format: 'jwk' }),
          alg: 'RS256',
          kid: 'test-1',
          use: 'sig',
        }
      : undefined,
    privateKey,
    token: `${header}.${payload}.${signature}`,
  };
}

const hostedEnvironment = {
  IOLAUS_MCP_OAUTH_ALGORITHMS: 'RS256',
  IOLAUS_MCP_OAUTH_JWKS_URI: jwksUri,
  IOLAUS_MCP_OAUTH_SCOPES: 'iolaus.mcp',
  IOLAUS_OIDC_ADMIN_EMAILS: 'owner@example.com',
  IOLAUS_OIDC_CLIENT_ID: 'iolaus',
  IOLAUS_OIDC_REALM: 'career',
  IOLAUS_OIDC_SERVER_URL: 'https://identity.example.com',
  IOLAUS_PUBLIC_URL: 'https://jobs.example.com',
  IOLAUS_WORKSPACE_MODE: 'shared',
  SMRT_APP_ID: 'iolaus-career',
  SMRT_RUNTIME_PROFILE: 'self-hosted',
};

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe('MCP OAuth resource authentication', () => {
  it('stays disabled until every hosted OAuth value is complete', () => {
    expect(getMcpOauthConfiguration(hostedEnvironment)).toMatchObject({
      issuer,
      jwksUri,
      resource,
      scopes: ['iolaus.mcp'],
    });
    expect(
      getMcpOauthConfiguration({
        ...hostedEnvironment,
        IOLAUS_MCP_OAUTH_JWKS_URI: '',
      }),
    ).toBeNull();
    expect(
      getMcpOauthConfiguration({
        ...hostedEnvironment,
        IOLAUS_MCP_OAUTH_ALGORITHMS: 'RS256,RS512',
      }),
    ).toBeNull();
  });

  it('accepts only an issuer-, audience-, scope-, and signature-validated token', async () => {
    const { jwk: publicJwk, privateKey, token } = tokenAndJwk();
    if (!publicJwk) throw new Error('Expected a generated verification key.');
    globalThis.fetch = vi.fn(
      async () =>
        new Response(JSON.stringify({ keys: [publicJwk] }), {
          headers: { 'content-type': 'application/json' },
        }),
    );
    const auth = createMcpOauthResourceAuth(
      {
        algorithms: ['RS256'],
        issuer,
        jwksUri,
        resource,
        scopes: ['iolaus.mcp'],
        tokenType: 'at+jwt',
      },
      async (identity) =>
        identity.subject === 'oidc-subject-1'
          ? { id: 'user-1', tenantId: 'tenant-1' }
          : null,
    );

    await expect(
      auth.authenticate(
        new Request(resource, {
          headers: { authorization: `Bearer ${token}` },
        }),
      ),
    ).resolves.toMatchObject({
      ok: true,
      principal: { id: 'user-1', tenantId: 'tenant-1' },
    });

    const wrongAudience = tokenAndJwk({
      audience: 'https://other.example/mcp',
      privateKey,
    });
    const denied = await auth.authenticate(
      new Request(resource, {
        headers: { authorization: `Bearer ${wrongAudience.token}` },
      }),
    );
    expect(denied.ok).toBe(false);
    if (!denied.ok) {
      expect(denied.response.status).toBe(401);
      expect(denied.response.headers.get('www-authenticate')).toContain(
        'resource_metadata=',
      );
    }

    const insufficientScope = tokenAndJwk({
      privateKey,
      scope: 'different.scope',
    });
    const scopeDenied = await auth.authenticate(
      new Request(resource, {
        headers: { authorization: `Bearer ${insufficientScope.token}` },
      }),
    );
    expect(scopeDenied.ok).toBe(false);
    if (!scopeDenied.ok) expect(scopeDenied.response.status).toBe(403);

    const wrongSignature = tokenAndJwk();
    const signatureDenied = await auth.authenticate(
      new Request(resource, {
        headers: { authorization: `Bearer ${wrongSignature.token}` },
      }),
    );
    expect(signatureDenied.ok).toBe(false);
    if (!signatureDenied.ok) expect(signatureDenied.response.status).toBe(401);
  });

  it('does not mistake opaque terminal Bearers for OAuth JWTs', () => {
    expect(
      isMcpOauthBearerRequest(
        new Request(resource, {
          headers: { authorization: 'Bearer session-id' },
        }),
      ),
    ).toBe(false);
    expect(
      isMcpOauthBearerRequest(
        new Request(resource, {
          headers: { authorization: 'Bearer header.payload.signature' },
        }),
      ),
    ).toBe(true);
  });
});
