import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  mode: 'enabled' as 'disabled' | 'enabled',
  deleteAccount: vi.fn(async (..._args: unknown[]) => ({
    deletionId: 'deletion-1',
    status: 'deleted',
    summary: {},
  })),
}));

vi.mock('@happyvertical/smrt-core', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@happyvertical/smrt-core')>()),
  detectEngine: () => 'sqlite',
  resolveDatabase: async () => ({ url: 'sqlite::memory:' }),
}));
vi.mock('$lib/server/account-deletion', () => ({
  ACCOUNT_DELETION_CONFIRMATION_PHRASE: 'DELETE MY ACCOUNT',
  ACCOUNT_DELETION_DISABLED_MESSAGE: 'disabled-message',
  AccountDeletionError: class extends Error {
    code = 'files';
  },
  accountDeletionConfirmed: (input: {
    email?: string | null;
    typedEmail?: string;
    typedPhrase?: string;
  }) =>
    input.typedEmail?.toLowerCase() === input.email?.toLowerCase() &&
    input.typedPhrase === 'DELETE MY ACCOUNT',
  accountDeletionMode: () => state.mode,
  deleteAccount: state.deleteAccount,
}));
vi.mock('$lib/server/app-config', () => ({
  getAppConfig: () => ({ appName: 'Iolaus' }),
}));
vi.mock('$lib/server/auth', () => ({ sessionCookieName: 'session_cookie' }));
vi.mock('$lib/server/db', () => ({ getDbConfig: () => ({ type: 'sqlite' }) }));
vi.mock('$lib/server/resume-files', () => ({
  getResumeFilesystem: async () => ({ delete: vi.fn(), exists: vi.fn() }),
}));

import { actions, load } from './+page.server';

const subject = {
  profileId: 'profile-a',
  tenantId: 'tenant-a',
  userId: 'user-a',
};
const locals = {
  membership: {
    roleId: 'role',
    status: 'active',
    tenantId: 'tenant-a',
    userId: 'user-a',
  },
  tenantId: 'tenant-a',
  user: { email: 'alice@example.invalid', id: 'user-a' },
  workspaceSubject: subject,
};

function event(fields: Record<string, string>, overrides = {}) {
  const body = new FormData();
  for (const [key, value] of Object.entries(fields)) body.set(key, value);
  const cookies = { delete: vi.fn() };
  return {
    cookies,
    locals,
    request: { formData: async () => body },
    ...overrides,
  };
}

const run = async (input: ReturnType<typeof event>) =>
  await (actions.delete as unknown as (e: unknown) => Promise<unknown>)(input);

const good = {
  acknowledge: 'on',
  confirmEmail: 'ALICE@example.invalid',
  confirmPhrase: 'DELETE MY ACCOUNT',
};

describe('account page deletion action', () => {
  beforeEach(() => {
    state.mode = 'enabled';
    state.deleteAccount.mockClear();
  });

  it('is disabled in private mode and deletes nothing', async () => {
    state.mode = 'disabled';
    const result = (await run(event(good))) as { status: number };
    expect(result.status).toBe(403);
    expect(state.deleteAccount).not.toHaveBeenCalled();
    const page = await (load as unknown as (e: unknown) => unknown)({
      locals,
      setHeaders: vi.fn(),
    });
    expect(page).toMatchObject({ deletionEnabled: false });
  });

  it.each([
    ['unchecked acknowledgement', { ...good, acknowledge: '' }],
    ['wrong email', { ...good, confirmEmail: 'bob@example.invalid' }],
    ['wrong phrase', { ...good, confirmPhrase: 'delete' }],
    ['no fields', {}],
  ])('rejects %s without deleting', async (_name, fields) => {
    const result = (await run(event(fields))) as { status: number };
    expect(result.status).toBe(400);
    expect(state.deleteAccount).not.toHaveBeenCalled();
  });

  it('deletes only the verified session subject, clears the cookie and redirects', async () => {
    const input = event({
      ...good,
      // Untrusted ids in the form must be ignored.
      tenantId: 'tenant-b',
      userId: 'user-b',
    });
    await expect(run(input)).rejects.toMatchObject({
      location: '/account-deleted/',
      status: 303,
    });
    expect(state.deleteAccount).toHaveBeenCalledTimes(1);
    expect(state.deleteAccount.mock.calls[0][0]).toEqual({
      tenantId: 'tenant-a',
      userId: 'user-a',
    });
    expect(state.deleteAccount.mock.calls[0][1]).toMatchObject({
      initiatedBy: 'self',
    });
    expect(input.cookies.delete).toHaveBeenCalledWith('session_cookie', {
      path: '/',
    });
  });

  it('keeps the user on the page with a recovery message when deletion fails', async () => {
    state.deleteAccount.mockRejectedValueOnce(new Error('boom'));
    const input = event(good);
    const result = (await run(input)) as {
      data: { error: string };
      status: number;
    };
    expect(result.status).toBe(500);
    expect(result.data.error).toMatch(/locked/u);
    expect(input.cookies.delete).not.toHaveBeenCalled();
  });

  it('refuses an unverified session', async () => {
    const result = (await run(
      event(good, {
        locals: { user: { email: 'alice@example.invalid', id: 'x' } },
      }),
    )) as { status: number };
    expect(result.status).toBe(403);
    expect(state.deleteAccount).not.toHaveBeenCalled();
  });
});
