import type { SmrtClassOptions } from '@happyvertical/smrt-core';
import { MagicLinkService } from '@happyvertical/smrt-users';
import {
  type AppConfigEnvironment,
  getAuthConfiguration,
  getConfiguredPublicOrigin,
} from './app-config.js';
import { getSmrtOptions } from './db.js';
import { isEmailInvited, normalizeInviteEmail } from './hosted-invite.js';
import {
  type InviteEmailOptions,
  sendMagicLinkEmail,
} from './hosted-invite-email.js';
import {
  clientAddressKey,
  defaultMagicLinkLimiters,
  type MagicLinkLimiters,
} from './login-rate-limit.js';

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/u;
const MAX_EMAIL_LENGTH = 254;
const MAX_TOKEN_LENGTH = 4096;

export interface MagicLinkContext extends InviteEmailOptions {
  /** Test seam: SMRT database options, defaulting to the application's. */
  smrtOptions?: SmrtClassOptions;
  limiters?: MagicLinkLimiters;
}

export type MagicLinkRequestOutcome =
  | 'sent'
  | 'delivery-failed'
  | 'rate-limited'
  | 'invalid-email'
  | 'not-invited';

export type MagicLinkConsumeOutcome =
  | { status: 'verified'; email: string }
  | { status: 'invalid' }
  | { status: 'not-invited' };

function magicLinkSettings(environment: AppConfigEnvironment) {
  const configuration = getAuthConfiguration(environment);
  if (configuration.kind !== 'magic-link') {
    throw new Error('Magic-link authentication is not configured.');
  }
  return configuration.magicLink;
}

async function magicLinkService(
  context: MagicLinkContext,
  environment: AppConfigEnvironment,
): Promise<MagicLinkService> {
  const settings = magicLinkSettings(environment);
  return await MagicLinkService.create({
    ...(context.smrtOptions ?? getSmrtOptions()),
    secret: settings.secret,
    tokenExpiry: settings.tokenExpirySeconds,
  });
}

/**
 * Handle a sign-in link request. The caller shows the same "check your email"
 * response whatever this returns: only an invited, rate-permitted, valid
 * address ever produces a token or an email, and the outcome is for tests and
 * operator logs, never for the visitor. Both limiters are charged before the
 * invitation is read so limiting cannot distinguish invited from uninvited.
 */
export async function requestMagicLink(
  rawEmail: string,
  clientAddress: string,
  context: MagicLinkContext = {},
): Promise<MagicLinkRequestOutcome> {
  const environment = context.environment ?? process.env;
  const limiters = context.limiters ?? defaultMagicLinkLimiters;
  const email = normalizeInviteEmail(rawEmail);

  // Charge the client address first: a throttled address must not keep
  // inserting mailbox keys. Both limits apply before the invite is read, so
  // limiting cannot distinguish invited from uninvited addresses.
  if (!limiters.ip.allow(`ip:${clientAddressKey(clientAddress)}`)) {
    return 'rate-limited';
  }
  // Only well-formed addresses are tracked, so junk cannot fill the mailbox map.
  if (!email || email.length > MAX_EMAIL_LENGTH || !EMAIL_PATTERN.test(email)) {
    return 'invalid-email';
  }
  if (!limiters.email.allow(`email:${email}`)) return 'rate-limited';
  const smrtOptions = context.smrtOptions;
  if (!(await isEmailInvited(email, smrtOptions as { db?: unknown }))) {
    return 'not-invited';
  }

  const origin = getConfiguredPublicOrigin(environment);
  if (!origin) throw new Error('IOLAUS_PUBLIC_URL is required for sign-in.');
  const service = await magicLinkService(context, environment);
  const { token } = await service.generate(email);
  const link = `${origin}/auth/magic-link?token=${encodeURIComponent(token)}`;
  const outcome = await sendMagicLinkEmail(
    email,
    link,
    magicLinkSettings(environment).tokenExpirySeconds / 60,
    context,
  );
  return outcome.status === 'sent' ? 'sent' : 'delivery-failed';
}

/**
 * Verify and consume a sign-in token (single use, signed, expiring), then
 * require the address to still hold an active invitation. A link requested
 * before a revocation therefore cannot complete sign-in.
 */
export async function consumeMagicLink(
  token: string,
  context: MagicLinkContext = {},
): Promise<MagicLinkConsumeOutcome> {
  const environment = context.environment ?? process.env;
  if (!token || token.length > MAX_TOKEN_LENGTH) return { status: 'invalid' };
  const service = await magicLinkService(context, environment);
  let email: string;
  try {
    ({ email } = await service.verify(token));
  } catch {
    return { status: 'invalid' };
  }
  const normalized = normalizeInviteEmail(email);
  const invited = await isEmailInvited(
    normalized,
    context.smrtOptions as { db?: unknown },
  );
  return invited
    ? { status: 'verified', email: normalized }
    : { status: 'not-invited' };
}
