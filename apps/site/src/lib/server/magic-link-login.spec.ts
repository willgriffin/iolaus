import { getTestDatabase } from '@happyvertical/smrt-core';
import { backfillProfileEmailKeys } from '@happyvertical/smrt-profiles';
import {
  backfillUserEmailKeys,
  UserCollection,
} from '@happyvertical/smrt-users';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getAuthConfiguration } from './app-config';
import { addInvite, revokeInvite } from './hosted-invite';
import type { InviteMessage } from './hosted-invite-email';
import {
  provisionHostedMagicLinkUser,
  provisionHostedOidcUser,
} from './hosted-oidc-provisioning';
import { createMagicLinkLimiters } from './login-rate-limit';
import { consumeMagicLink, requestMagicLink } from './magic-link-login';
import './smrt.js';

const SECRET = 'a-very-long-test-only-signing-secret-0123456789';
const env = {
  SMRT_RUNTIME_PROFILE: 'self-hosted',
  SMRT_APP_ID: 'jobgenius',
  IOLAUS_APP_NAME: 'JobGenius',
  IOLAUS_WORKSPACE_MODE: 'shared',
  IOLAUS_PUBLIC_URL: 'https://app.example.com',
  IOLAUS_AUTH_MODE: 'magic-link',
  IOLAUS_MAGIC_LINK_SECRET: SECRET,
  SMTP_HOST: 'smtp.example.com',
  SMTP_USER: 'user',
  SMTP_PASSWORD: 'pw',
  SMTP_FROM: 'JobGenius <noreply@example.com>',
};

function fakeTransport() {
  const sent: InviteMessage[] = [];
  return {
    sent,
    sendMail: vi.fn(async (message: InviteMessage) => {
      sent.push(message);
    }),
  };
}

function tokenFrom(message: InviteMessage | undefined): string {
  const match = message?.text.match(/\/auth\/magic-link\?token=([^\s]+)/u);
  if (!match) throw new Error('no sign-in link in message');
  return decodeURIComponent(match[1]);
}

describe('magic-link auth configuration', () => {
  it('is valid only for self-hosted shared installs with secret and SMTP', () => {
    expect(getAuthConfiguration(env)).toMatchObject({
      kind: 'magic-link',
      magicLink: { tokenExpirySeconds: 900 },
    });
    for (const broken of [
      { IOLAUS_WORKSPACE_MODE: 'private' },
      { SMRT_RUNTIME_PROFILE: 'cloud' },
      { IOLAUS_MAGIC_LINK_SECRET: 'short' },
      { SMTP_HOST: '' },
      { IOLAUS_PUBLIC_URL: '' },
    ]) {
      expect(getAuthConfiguration({ ...env, ...broken })).toMatchObject({
        kind: 'invalid',
      });
    }
    expect(
      getAuthConfiguration({ ...env, IOLAUS_AUTH_MODE: 'password' }),
    ).toMatchObject({ kind: 'invalid' });
    expect(
      getAuthConfiguration({ ...env, IOLAUS_AUTH_MODE: undefined }),
    ).toMatchObject({ kind: 'invalid' });
  });
});

describe('magic-link sign-in', () => {
  let db: Awaited<ReturnType<typeof getTestDatabase>> | undefined;

  beforeEach(async () => {
    db = await getTestDatabase({
      classes: ['HostedInvite', 'UsersMagicLinkToken'],
    });
  });
  afterEach(async () => {
    vi.useRealTimers();
    await db?.close?.();
    db = undefined;
  });

  function context(extra: Record<string, unknown> = {}) {
    const transport = fakeTransport();
    return {
      transport,
      context: {
        environment: env,
        smrtOptions: { db },
        transport,
        db,
        ...extra,
      } as never,
    };
  }

  it('emails an invited address a link that signs in exactly once', async () => {
    await addInvite('friend@example.invalid', { db });
    const { transport, context: ctx } = context();

    await expect(
      requestMagicLink(' Friend@Example.invalid ', '203.0.113.1', ctx),
    ).resolves.toBe('sent');
    expect(transport.sent).toHaveLength(1);
    expect(transport.sent[0].to).toBe('friend@example.invalid');
    expect(transport.sent[0].text).toContain('https://app.example.com/auth/');

    const token = tokenFrom(transport.sent[0]);
    await expect(consumeMagicLink(token, ctx)).resolves.toEqual({
      status: 'verified',
      email: 'friend@example.invalid',
    });
    await expect(consumeMagicLink(token, ctx)).resolves.toEqual({
      status: 'invalid',
    });
  });

  it('sends nothing and mints no token for an uninvited or malformed address', async () => {
    const { transport, context: ctx } = context();
    await expect(
      requestMagicLink('stranger@example.invalid', '203.0.113.2', ctx),
    ).resolves.toBe('not-invited');
    await expect(
      requestMagicLink('not-an-email', '203.0.113.2', ctx),
    ).resolves.toBe('invalid-email');
    expect(transport.sent).toHaveLength(0);
    const rows = await db?.query(
      'SELECT count(*) AS n FROM users_magic_link_tokens',
    );
    expect(Number((rows as { n: number }[] | undefined)?.[0]?.n ?? 0)).toBe(0);
  });

  it('rejects tampered, garbage and expired tokens', async () => {
    await addInvite('friend@example.invalid', { db });
    const { transport, context: ctx } = context();
    await requestMagicLink('friend@example.invalid', '203.0.113.3', ctx);
    const token = tokenFrom(transport.sent[0]);

    const tampered = `${token.slice(0, -4)}${token.endsWith('AAAA') ? 'BBBB' : 'AAAA'}`;
    await expect(consumeMagicLink(tampered, ctx)).resolves.toEqual({
      status: 'invalid',
    });
    await expect(consumeMagicLink('garbage', ctx)).resolves.toEqual({
      status: 'invalid',
    });
    await expect(consumeMagicLink('', ctx)).resolves.toEqual({
      status: 'invalid',
    });

    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.now() + 16 * 60 * 1000);
    await expect(consumeMagicLink(token, ctx)).resolves.toEqual({
      status: 'invalid',
    });
  });

  it('blocks a pending link once the invitation is revoked', async () => {
    await addInvite('friend@example.invalid', { db });
    const { transport, context: ctx } = context();
    await requestMagicLink('friend@example.invalid', '203.0.113.4', ctx);
    await revokeInvite('friend@example.invalid', { db });

    await expect(
      consumeMagicLink(tokenFrom(transport.sent[0]), ctx),
    ).resolves.toEqual({ status: 'not-invited' });
  });

  it('limits requests per mailbox and per client address', async () => {
    await addInvite('friend@example.invalid', { db });
    const limiters = createMagicLinkLimiters();
    const { transport, context: ctx } = context({ limiters });

    const outcomes: string[] = [];
    for (let i = 0; i < 7; i += 1) {
      outcomes.push(
        await requestMagicLink(
          'friend@example.invalid',
          `198.51.100.${i}`,
          ctx,
        ),
      );
    }
    expect(outcomes.slice(0, 5)).toEqual(Array(5).fill('sent'));
    expect(outcomes.slice(5)).toEqual(['rate-limited', 'rate-limited']);
    expect(transport.sent).toHaveLength(5);

    const ipOnly = createMagicLinkLimiters();
    const { transport: t2, context: ctx2 } = context({ limiters: ipOnly });
    for (let i = 0; i < 20; i += 1) {
      await requestMagicLink(`u${i}@example.invalid`, '192.0.2.9', ctx2);
    }
    await expect(
      requestMagicLink('friend@example.invalid', '192.0.2.9', ctx2),
    ).resolves.toBe('rate-limited');
    expect(t2.sent).toHaveLength(0);
  });

  it('does not email when SMTP delivery is unavailable', async () => {
    await addInvite('friend@example.invalid', { db });
    const transport = {
      sendMail: vi.fn(async () => {
        throw Object.assign(new Error('down'), { code: 'ECONNECTION' });
      }),
    };
    await expect(
      requestMagicLink('friend@example.invalid', '203.0.113.5', {
        environment: env,
        smrtOptions: { db },
        transport,
        db,
      } as never),
    ).resolves.toBe('delivery-failed');
  });
});

describe('magic-link provisioning with released SMRT', () => {
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
        'ProfileType',
        'User',
      ],
    });
    await backfillProfileEmailKeys(db);
    await backfillUserEmailKeys(db);
    return await UserCollection.create({ db });
  }

  it('creates one user and reuses it on every later sign-in', async () => {
    const collection = await users();
    const first = await provisionHostedMagicLinkUser(
      'Friend@Example.invalid',
      collection,
    );
    const again = await provisionHostedMagicLinkUser(
      'friend@example.invalid',
      collection,
    );
    expect(first.id).toBeDefined();
    expect(again.id).toBe(first.id);
  });

  it('reuses the existing account of a verified email from an earlier OIDC sign-in', async () => {
    const collection = await users();
    const oidc = await provisionHostedOidcUser(
      {
        email: 'friend@example.invalid',
        email_verified: true,
        iss: 'https://identity.example.invalid/realms/career',
        sub: 'subject-1',
      },
      collection,
    );
    const viaLink = await provisionHostedMagicLinkUser(
      'friend@example.invalid',
      collection,
    );
    expect(viaLink.id).toBe(oidc.id);
  });

  it('rejects a blank address', async () => {
    const collection = await users();
    await expect(
      provisionHostedMagicLinkUser('  ', collection),
    ).rejects.toThrow();
  });
});
