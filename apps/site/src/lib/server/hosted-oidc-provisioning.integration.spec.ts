import { getTestDatabase } from '@happyvertical/smrt-core';
import { backfillProfileEmailKeys } from '@happyvertical/smrt-profiles';
import {
  backfillUserEmailKeys,
  UserCollection,
} from '@happyvertical/smrt-users';
import { afterEach, describe, expect, it } from 'vitest';
import { provisionHostedOidcUser } from './hosted-oidc-provisioning';

describe('hosted OIDC provisioning with released SMRT', () => {
  let db: Awaited<ReturnType<typeof getTestDatabase>> | undefined;

  afterEach(async () => {
    await db?.close?.();
    db = undefined;
  });

  async function users() {
    db = await getTestDatabase({
      classes: [
        'OidcIdentity',
        'OidcProfileEmailReservation',
        'Profile',
        'User',
      ],
    });
    await backfillProfileEmailKeys(db);
    await backfillUserEmailKeys(db);
    return await UserCollection.create({ db });
  }

  it('provisions a fresh verified identity and reuses it on repeat login', async () => {
    const collection = await users();
    const claims = {
      email: 'fresh-owner@example.invalid',
      email_verified: true,
      iss: 'https://identity.example.invalid/realms/career',
      sub: 'fresh-subject',
    };

    const first = await provisionHostedOidcUser(claims, collection);
    const repeat = await provisionHostedOidcUser(claims, collection);

    expect(first.id).toBeDefined();
    expect(repeat.id).toBe(first.id);
  });

  it('lets an unmatched imported-owner binding fall through to SMRT', async () => {
    const collection = await users();
    const claims = {
      email: 'unmatched-owner@example.invalid',
      email_verified: true,
      iss: 'https://identity.example.invalid/realms/career',
      sub: 'unmatched-subject',
    };

    const user = await provisionHostedOidcUser(claims, collection, [
      {
        issuer: claims.iss,
        subject: 'different-subject',
        userId: '11111111-1111-4111-8111-111111111111',
      },
    ]);

    expect(user.id).toBeDefined();
  });

  it('rejects an invalid matching imported-owner binding', async () => {
    const collection = await users();
    const claims = {
      email: 'denied-owner@example.invalid',
      email_verified: true,
      iss: 'https://identity.example.invalid/realms/career',
      sub: 'denied-subject',
    };

    await expect(
      provisionHostedOidcUser(claims, collection, [
        {
          issuer: claims.iss,
          subject: claims.sub,
          userId: '11111111-1111-4111-8111-111111111111',
        },
      ]),
    ).rejects.toMatchObject({
      code: 'rejected',
    });
  });

  it('refuses a second subject from taking over an owned profile', async () => {
    const collection = await users();
    const claims = {
      email: 'owned-owner@example.invalid',
      email_verified: true,
      iss: 'https://identity.example.invalid/realms/career',
      sub: 'first-subject',
    };
    await provisionHostedOidcUser(claims, collection);

    await expect(
      provisionHostedOidcUser({ ...claims, sub: 'second-subject' }, collection),
    ).rejects.toMatchObject({
      code: 'profile_owned',
    });
  });
});
