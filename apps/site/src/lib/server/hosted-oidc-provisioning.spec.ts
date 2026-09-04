import type { User } from '@happyvertical/smrt-users';
import { describe, expect, it, vi } from 'vitest';
import {
  hostedOidcProvider,
  provisionHostedOidcUser,
} from './hosted-oidc-provisioning';

const mocks = vi.hoisted(() => ({
  profileGet: vi.fn(),
  profileCreate: vi.fn(),
}));

vi.mock('@happyvertical/smrt-profiles', () => ({
  ProfileCollection: { create: mocks.profileCreate },
}));

describe('hosted OIDC identity provisioning', () => {
  it('delegates the exact issuer, subject, and verified email to SMRT', async () => {
    const user = {
      email: 'owner@example.invalid',
      id: '11111111-1111-4111-8111-111111111111',
    } as User;
    const getOrCreateFromOidc = vi.fn(async () => ({ user }));
    const claims = {
      email: 'owner@example.invalid',
      email_verified: true,
      iss: 'https://identity.example.invalid/realms/career',
      name: 'Synthetic Owner',
      preferred_username: 'synthetic-owner',
      sub: 'subject-immutable-1',
    };

    await expect(
      provisionHostedOidcUser(claims, { getOrCreateFromOidc }),
    ).resolves.toBe(user);

    expect(getOrCreateFromOidc).toHaveBeenCalledWith(
      claims,
      hostedOidcProvider,
      {
        authorizeProfileOwner: expect.any(Function),
      },
    );
  });

  it('reuses the imported owner only for an exact approved issuer and subject', async () => {
    const existingUserId = '11111111-1111-4111-8111-111111111111';
    const existingProfileId = '22222222-2222-4222-8222-222222222222';
    const existingUser = {
      email: 'owner@example.invalid',
      id: existingUserId,
      profileId: existingProfileId,
      status: 'active',
    } as User;
    const profile = { id: existingUser.profileId };
    const get = vi.fn(async () => existingUser);
    mocks.profileGet.mockResolvedValue(profile);
    mocks.profileCreate.mockResolvedValue({ get: mocks.profileGet });
    const getOrCreateFromOidc = vi.fn(async (_claims, _provider, options) => {
      const authorization = await options.authorizeProfileOwner({
        claims,
        db: {},
        users: { get },
      });
      expect(authorization).toEqual({ profile, user: existingUser });
      return { user: authorization.user };
    });
    const claims = {
      email: 'owner@example.invalid',
      email_verified: true,
      iss: 'https://identity.example.invalid/realms/career',
      sub: 'subject-immutable-1',
    };

    await expect(
      provisionHostedOidcUser(claims, { getOrCreateFromOidc }, [
        {
          issuer: claims.iss,
          subject: claims.sub,
          userId: existingUserId,
        },
      ]),
    ).resolves.toBe(existingUser);
    expect(get).toHaveBeenCalledWith({ id: existingUserId });
    expect(mocks.profileGet).toHaveBeenCalledWith({
      id: existingUser.profileId,
    });
  });

  it('fails closed for an unapproved first binding to an imported owner', async () => {
    const authorizations: unknown[] = [];
    const getOrCreateFromOidc = vi.fn(async (_claims, _provider, options) => {
      const authorization = await options.authorizeProfileOwner({
        claims: _claims,
        db: {},
        users: { get: vi.fn() },
      });
      authorizations.push(authorization);
      if (!authorization) throw new Error('profile_owned');
      return { user: authorization.user };
    });
    const claims = {
      email: 'owner@example.invalid',
      email_verified: true,
      iss: 'https://identity.example.invalid/realms/career',
      sub: 'subject-immutable-1',
    };

    await expect(
      provisionHostedOidcUser(claims, { getOrCreateFromOidc }),
    ).rejects.toThrow('profile_owned');
    await expect(
      provisionHostedOidcUser(
        { ...claims, email_verified: false },
        { getOrCreateFromOidc },
        [
          {
            issuer: claims.iss,
            subject: claims.sub,
            userId: '11111111-1111-4111-8111-111111111111',
          },
        ],
      ),
    ).rejects.toThrow('profile_owned');
    expect(authorizations).toEqual([null, null]);
  });

  it('does not replace SMRT ownership failures with an email-only fallback', async () => {
    const getOrCreateFromOidc = vi.fn(async () => {
      throw new Error('profile_owned');
    });

    await expect(
      provisionHostedOidcUser(
        {
          email: 'owner@example.invalid',
          email_verified: true,
          iss: 'https://identity.example.invalid/realms/career',
          sub: 'subject-immutable-1',
        },
        { getOrCreateFromOidc },
      ),
    ).rejects.toThrow('profile_owned');
    expect(getOrCreateFromOidc).toHaveBeenCalledOnce();
  });
});
