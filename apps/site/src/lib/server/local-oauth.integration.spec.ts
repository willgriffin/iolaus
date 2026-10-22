import './manifest-preload.js';
import { createHash } from 'node:crypto';
import { getRetentionTasks, getTestDatabase } from '@happyvertical/smrt-core';
import {
  MembershipCollection,
  PermissionCollection,
  RoleCollection,
  RolePermissionCollection,
  SessionService,
  TenantCollection,
  UserCollection,
  UsersOAuthRefreshGrantCollection,
} from '@happyvertical/smrt-users';
import { exportJWK, generateKeyPair } from 'jose';
import { expect, it, vi } from 'vitest';

vi.mock('./app-config.js', () => ({
  getConfiguredPublicOrigin: (env: NodeJS.ProcessEnv) =>
    env.IOLAUS_PUBLIC_URL ?? null,
}));
vi.mock('./db.js', () => ({ getSmrtOptions: () => ({}) }));

import { createLocalOAuth } from './local-oauth';

it('uses native session-backed grants from app consent through token use and account revocation', async () => {
  const db = await getTestDatabase({
    classes: [
      'User',
      'Tenant',
      'Role',
      'Permission',
      'RolePermission',
      'Membership',
      'MembershipOverride',
      'TenantPermissionOverride',
      'Group',
      'GroupMember',
      'GroupRole',
      'Session',
      'UsersOAuthClient',
      'UsersOAuthAuthorizationCode',
      'UsersOAuthAuthorization',
      'UsersOAuthRefreshGrant',
      'UsersOAuthRefreshFamily',
      'UsersOAuthAccessTokenRevocation',
    ],
  });
  try {
    const options = { db };
    const users = await UserCollection.create(options);
    const user = await users.create({ email: 'oauth-owner@example.invalid' });
    const foreign = await users.create({
      email: 'oauth-foreign@example.invalid',
    });
    const tenant = await (await TenantCollection.create(options)).create({
      name: 'OAuth fixture',
    });
    const role = await (await RoleCollection.create(options)).create({
      name: 'OAuth reader',
    });
    const permission = await (
      await PermissionCollection.create(options)
    ).create({
      name: 'Inspect workspace',
      slug: 'workflow.application.inspect',
    });
    await (await RolePermissionCollection.create(options)).addPermission(
      role.id as string,
      permission.id as string,
    );
    await (await MembershipCollection.create(options)).create({
      userId: user.id as string,
      tenantId: tenant.id as string,
      roleId: role.id as string,
    });
    const sessions = await SessionService.create(options);
    const sessionId = await sessions.createSession(
      user.id as string,
      tenant.id as string,
      { authMethod: 'magic-link' },
    );
    const foreignSession = await sessions.createSession(foreign.id as string);
    const keys = await generateKeyPair('ES256', { extractable: true });
    const oauth = await createLocalOAuth(
      {
        IOLAUS_MCP_LOCAL_OAUTH_ENABLED: 'true',
        IOLAUS_PUBLIC_URL: 'https://jobs.test',
        IOLAUS_MCP_OAUTH_KEY_ID: 'fixture',
        IOLAUS_MCP_OAUTH_PRIVATE_JWK: JSON.stringify(
          await exportJWK(keys.privateKey),
        ),
      },
      options,
    );
    if (!oauth) throw new Error('Missing OAuth fixture');
    const client = await oauth.server.register({
      redirect_uris: ['https://client.test/callback'],
      scope: 'opportunities:read applications:prepare',
    });
    const verifier = 'a'.repeat(43);
    const request = await oauth.server.parseAuthorizationRequest(
      new URLSearchParams({
        client_id: client.client_id,
        redirect_uri: 'https://client.test/callback',
        response_type: 'code',
        scope: 'opportunities:read',
        resource: oauth.resource,
        code_challenge: createHash('sha256')
          .update(verifier)
          .digest('base64url'),
        code_challenge_method: 'S256',
      }),
    );
    await expect(
      oauth.authorization.approve(
        oauth.server,
        { ...request, scopes: ['applications:prepare'] },
        sessionId,
      ),
    ).rejects.toThrow();
    const approved = await oauth.authorization.approve(
      oauth.server,
      request,
      sessionId,
    );
    const exchange = new URLSearchParams({
      grant_type: 'authorization_code',
      code: new URL(approved.redirectUri).searchParams.get('code') as string,
      client_id: client.client_id,
      redirect_uri: request.redirectUri,
      code_verifier: verifier,
      resource: oauth.resource,
    });
    const token = await oauth.server.token(exchange);
    await expect(oauth.server.token(exchange)).rejects.toThrow();
    await expect(
      oauth.server.verifyAccessToken(
        token.access_token,
        'http://127.0.0.1:5173/api/mcp',
      ),
    ).rejects.toThrow();
    const claims = await oauth.server.verifyAccessToken(
      token.access_token,
      oauth.resource,
    );
    const live = await oauth.authorization.validateAccessTokenClaims(claims);
    expect(live?.user.id).toBe(user.id);
    expect(live?.permissions).toEqual(['workflow.application.inspect']);
    const grants = await oauth.authorization.listGrants(sessionId);
    expect(grants).toHaveLength(1);
    expect(await oauth.authorization.listGrants(foreignSession)).toEqual([]);
    expect(
      await oauth.authorization.revokeGrant(foreignSession, grants[0].id),
    ).toBe(false);
    expect(await oauth.authorization.revokeGrant(sessionId, grants[0].id)).toBe(
      true,
    );
    expect(
      await oauth.authorization.validateAccessTokenClaims(claims),
    ).toBeNull();
    await expect(
      oauth.server.token(
        new URLSearchParams({
          grant_type: 'refresh_token',
          refresh_token: token.refresh_token as string,
          client_id: client.client_id,
          resource: oauth.resource,
        }),
      ),
    ).rejects.toThrow();
    // The published closure must preserve spent refresh hashes through expiry,
    // so replay can still revoke a live replacement after credential cleanup.
    const replayApproval = await oauth.authorization.approve(
      oauth.server,
      request,
      sessionId,
    );
    exchange.set(
      'code',
      new URL(replayApproval.redirectUri).searchParams.get('code') as string,
    );
    const replayToken = await oauth.server.token(exchange);
    const refresh = new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: replayToken.refresh_token as string,
      client_id: client.client_id,
      resource: oauth.resource,
    });
    const replacement = await oauth.server.token(refresh);
    const refreshRows = await UsersOAuthRefreshGrantCollection.create({ db });
    await db.query(
      `UPDATE ${refreshRows.tableName} SET expires_at = ? WHERE consumed_at IS NOT NULL`,
      new Date(Date.now() - 86400000).toISOString(),
    );
    const retention = getRetentionTasks().find(
      (task) => task.name === 'users-oauth-credentials',
    );
    expect(retention).toBeDefined();
    await retention?.run(db, { dryRun: false, now: new Date() });
    const retained = await db.query(
      `SELECT id FROM ${refreshRows.tableName} WHERE consumed_at IS NOT NULL`,
    );
    expect(retained.rows).toHaveLength(1);
    await expect(oauth.server.token(refresh)).rejects.toThrow();
    refresh.set('refresh_token', replacement.refresh_token as string);
    await expect(oauth.server.token(refresh)).rejects.toThrow();
  } finally {
    await db.close?.();
  }
}, 15000);
