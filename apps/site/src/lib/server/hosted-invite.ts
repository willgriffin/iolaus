import type { HostedInvite } from '../objects/HostedInvite.js';
import { getCollection } from './smrt.js';

/** Test seam: a database handle or config, defaulting to the application's. */
export interface HostedInviteStoreOptions {
  db?: unknown;
}

export type HostedInviteStatus = 'invited' | 'revoked';

export interface HostedInviteSummary {
  email: string;
  status: HostedInviteStatus;
}

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/u;

/** Trim and lower-case an email; empty string when it is absent. */
export function normalizeInviteEmail(email: string | null | undefined): string {
  return email?.trim().toLowerCase() ?? '';
}

/** Normalize and validate an operator-supplied address, or throw. */
export function requireInviteEmail(email: string | null | undefined): string {
  const normalized = normalizeInviteEmail(email);
  if (!EMAIL_PATTERN.test(normalized)) {
    throw new Error(`"${email ?? ''}" is not a valid email address.`);
  }
  return normalized;
}

async function inviteCollection(options: HostedInviteStoreOptions) {
  return await getCollection<HostedInvite>(
    'HostedInvite',
    options.db ? ({ db: options.db } as never) : {},
  );
}

async function findInvite(
  email: string,
  options: HostedInviteStoreOptions,
): Promise<HostedInvite | null> {
  const collection = await inviteCollection(options);
  const [invite] = await collection.list({ limit: 1, where: { email } });
  return invite ?? null;
}

/**
 * Whether the email currently holds an active (not revoked) invitation. This is
 * read live from storage on every call: it is the login gate and the
 * per-request re-check, so a revocation takes effect on the next request.
 */
export async function isEmailInvited(
  email: string | null | undefined,
  options: HostedInviteStoreOptions = {},
): Promise<boolean> {
  const normalized = normalizeInviteEmail(email);
  if (!normalized) return false;
  const invite = await findInvite(normalized, options);
  return Boolean(invite && !invite.revokedAt);
}

/** Invite an address, reinstating a previously revoked invitation. */
export async function addInvite(
  email: string,
  options: HostedInviteStoreOptions = {},
): Promise<{ email: string; result: 'created' | 'reinstated' | 'unchanged' }> {
  const normalized = requireInviteEmail(email);
  const existing = await findInvite(normalized, options);
  if (existing) {
    if (!existing.revokedAt) return { email: normalized, result: 'unchanged' };
    existing.revokedAt = null;
    await existing.save();
    return { email: normalized, result: 'reinstated' };
  }
  const collection = await inviteCollection(options);
  const invite = await collection.create({ email: normalized });
  await invite.save();
  return { email: normalized, result: 'created' };
}

/** Revoke an invitation; reports `not-found` when it was never issued. */
export async function revokeInvite(
  email: string,
  options: HostedInviteStoreOptions = {},
): Promise<{ email: string; result: 'revoked' | 'unchanged' | 'not-found' }> {
  const normalized = requireInviteEmail(email);
  const existing = await findInvite(normalized, options);
  if (!existing) return { email: normalized, result: 'not-found' };
  if (existing.revokedAt) return { email: normalized, result: 'unchanged' };
  existing.revokedAt = new Date();
  await existing.save();
  return { email: normalized, result: 'revoked' };
}

export async function listInvites(
  options: HostedInviteStoreOptions = {},
): Promise<HostedInviteSummary[]> {
  const collection = await inviteCollection(options);
  const invites = await collection.list({});
  return invites
    .map((invite) => ({
      email: invite.email,
      status: (invite.revokedAt ? 'revoked' : 'invited') as HostedInviteStatus,
    }))
    .sort((left, right) => left.email.localeCompare(right.email));
}
