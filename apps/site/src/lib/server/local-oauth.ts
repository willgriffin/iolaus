import { createAuthorizationServer } from '@happyvertical/auth/server';
import {
  resolveDatabase,
  type SmrtClassOptions,
} from '@happyvertical/smrt-core';
import {
  SmrtOAuthAuthorizationService,
  SmrtOAuthAuthorizationStorage,
} from '@happyvertical/smrt-users';
import { importJWK } from 'jose';
import { getConfiguredPublicOrigin } from './app-config.js';
import { getSmrtOptions } from './db.js';

export const oauthScopePermissions: Readonly<
  Record<string, readonly string[]>
> = {
  'opportunities:read': ['workflow.application.inspect'],
  'profile:read': ['workflow.application.inspect'],
  'applications:prepare': [
    'workflow.application.prepare',
    'workflow.application.inspect',
  ],
};
export const oauthScopeDescriptions: Record<string, string> = {
  'opportunities:read': 'Read your opportunity workspace and applications.',
  'profile:read': 'Read your candidate profile for application preparation.',
  'applications:prepare':
    'Prepare draft application materials. Human review and submission remain separate.',
};
export function localOAuthConfiguration(environment = process.env) {
  if (environment.IOLAUS_MCP_LOCAL_OAUTH_ENABLED !== 'true') return null;
  const origin = getConfiguredPublicOrigin(environment);
  if (!origin || new URL(origin).protocol !== 'https:')
    throw new Error('Local OAuth requires an HTTPS public origin.');
  const keyId = environment.IOLAUS_MCP_OAUTH_KEY_ID?.trim();
  if (!keyId || !environment.IOLAUS_MCP_OAUTH_PRIVATE_JWK)
    throw new Error('Local OAuth signing configuration is incomplete.');
  return {
    issuer: `${origin}/oauth`,
    resource: `${origin}/api/mcp`,
    keyId,
    privateJwk: environment.IOLAUS_MCP_OAUTH_PRIVATE_JWK,
  };
}
export async function createLocalOAuth(
  environment = process.env,
  smrtOptions: SmrtClassOptions = getSmrtOptions(),
) {
  const config = localOAuthConfiguration(environment);
  if (!config) return null;
  let key: Record<string, string>;
  try {
    key = JSON.parse(config.privateJwk);
  } catch {
    throw new Error('Invalid OAuth signing key.');
  }
  if (key.kty !== 'EC' || key.crv !== 'P-256' || !key.d || !key.x || !key.y)
    throw new Error('OAuth requires a private ES256 key.');
  const publicJwk = { kty: 'EC', crv: 'P-256', x: key.x, y: key.y };
  const privateKey = await importJWK({ ...publicJwk, d: key.d }, 'ES256');
  const publicKey = await importJWK(publicJwk, 'ES256');
  const authorization = await SmrtOAuthAuthorizationService.create({
    ...smrtOptions,
    scopePermissions: oauthScopePermissions,
  });
  const databaseConfig = smrtOptions.db;
  const server = createAuthorizationServer({
    issuer: config.issuer,
    resources: [config.resource],
    scopes: Object.keys(oauthScopePermissions),
    storage: await SmrtOAuthAuthorizationStorage.create({
      ...smrtOptions,
      ...(databaseConfig &&
      typeof databaseConfig === 'object' &&
      'type' in databaseConfig &&
      databaseConfig.type === 'sqlite' &&
      'url' in databaseConfig &&
      typeof databaseConfig.url === 'string' &&
      databaseConfig.url !== ':memory:'
        ? {
            recoverDatabase: async () => {
              const db = await resolveDatabase(databaseConfig, {
                dbid: `iolaus-oauth-storage:${databaseConfig.url}`,
              });
              await db.query('PRAGMA foreign_keys = ON');
              return db;
            },
          }
        : {}),
    }),
    identity: authorization.identity,
    signingKey: {
      algorithm: 'ES256',
      keyId: config.keyId,
      privateKey,
      publicKey,
      publicJwk,
    },
    dynamicClientRegistration: true,
  });
  return {
    server,
    authorization,
    resource: config.resource,
    issuer: config.issuer,
  };
}
let runtime: ReturnType<typeof createLocalOAuth> | undefined;
export function getLocalOAuth() {
  runtime ??= createLocalOAuth().catch((error) => {
    runtime = undefined;
    throw error;
  });
  return runtime;
}
export function oauthFailure(status = 401) {
  return new Response('OAuth authorization failed.', {
    status,
    headers: {
      'cache-control': 'private, no-store',
      'www-authenticate': `Bearer error="invalid_token", resource_metadata="${getConfiguredPublicOrigin()}/.well-known/oauth-protected-resource/api/mcp"`,
    },
  });
}
