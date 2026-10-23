import { render } from 'svelte/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AccountDeletionError } from '$lib/server/account-deletion';
import { ResumeImportLifecycleBusyError } from '$lib/server/resume-import-account-fence.js';
import type { PageData } from './$types';

const state = vi.hoisted(() => ({
  mode: 'enabled' as 'disabled' | 'enabled',
  terminal: false,
  terminalFails: false,
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
    constructor(
      readonly code: string,
      message: string,
    ) {
      super(message);
    }
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
vi.mock('$lib/server/terminal-auth', () => ({
  isTerminalSession: async () => {
    if (state.terminalFails) throw new Error('session store down');
    return state.terminal;
  },
}));
vi.mock('$lib/server/resume-files', () => ({
  getResumeFilesystem: async () => ({ delete: vi.fn(), exists: vi.fn() }),
}));

import { actions, load } from './+page.server';
import AccountPage from './+page.svelte';

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
  sessionId: 'sess-1',
  tenantId: 'tenant-a',
  user: { email: 'alice@example.invalid', id: 'user-a' },
  workspaceSubject: subject,
};

function event(fields: Record<string, string>, overrides = {}) {
  const body = new FormData();
  for (const [key, value] of Object.entries(fields)) body.set(key, value);
  const cookies = {
    delete: vi.fn(),
    get: vi.fn(() => 'sess-1'),
  };
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
    state.terminal = false;
    state.terminalFails = false;
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

  it('reports a retryable refusal without claiming the account was locked', async () => {
    state.deleteAccount.mockRejectedValueOnce(
      new ResumeImportLifecycleBusyError(),
    );
    const input = event(good);
    const result = await run(input);
    expect(result).toMatchObject({
      status: 503,
      data: { error: expect.stringContaining('try again') },
    });
    expect(input.cookies.delete).not.toHaveBeenCalled();
  });

  it('reports pending source writes without redirecting to account deleted', async () => {
    state.deleteAccount.mockRejectedValueOnce(
      Object.assign(
        new AccountDeletionError(
          'pending-source-writes',
          'pending source writes; retry after recovery',
        ),
        { code: 'pending-source-writes' },
      ),
    );
    const input = event(good);
    expect(await run(input)).toMatchObject({
      status: 503,
      data: { error: expect.stringContaining('pending source writes') },
    });
    expect(input.cookies.delete).not.toHaveBeenCalled();
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

  it('refuses a terminal bearer token: only the cookie session may delete', async () => {
    const input = event(good);
    input.cookies.get.mockReturnValue(undefined as never);
    const result = (await run(input)) as { status: number };
    expect(result.status).toBe(403);
    const other = event(good);
    other.cookies.get.mockReturnValue('a-different-session' as never);
    expect(((await run(other)) as { status: number }).status).toBe(403);
    expect(state.deleteAccount).not.toHaveBeenCalled();
  });

  it('refuses a terminal-kind session even when its id arrives as the cookie', async () => {
    state.terminal = true;
    const result = (await run(event(good))) as { status: number };
    expect(result.status).toBe(403);
    expect(state.deleteAccount).not.toHaveBeenCalled();
  });

  it('fails closed when the session kind cannot be read', async () => {
    state.terminalFails = true;
    const result = (await run(event(good))) as { status: number };
    expect(result.status).toBe(403);
    expect(state.deleteAccount).not.toHaveBeenCalled();
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

describe('account deletion disclosure', () => {
  const data = {
    accountConnectionsEnabled: false,
    activityScopeKey: null,
    aiBudget: null,
    appMark: 'I',
    assistantEnabled: false,
    legalLinks: { landing: null, privacy: null, support: null, terms: null },
    permissions: [],
    publicOpportunityBrowserEnabled: false,
    resources: [],
    tenantId: locals.tenantId,
    user: locals.user,
    appName: 'Iolaus',
    email: 'alice@example.invalid',
    confirmationPhrase: 'DELETE MY ACCOUNT',
    deletionEnabled: true,
    deletionDisabledMessage: 'disabled-message',
  } satisfies PageData;

  it('discloses uploaded-original recovery before opening final confirmation', () => {
    const { body } = render(AccountPage, { props: { data, form: null } });
    const text = body.replace(/<[^>]*>/gu, ' ').replace(/\s+/gu, ' ');
    expect(text).toContain('Deletion immediately removes your account access');
    expect(text).toContain(
      'uploaded original PDFs in the private import store',
    );
    expect(text).toContain('recoverable for 30 days after deletion');
    expect(text).toContain('private quarantine');
    expect(text).toContain('explicit operator authorization');
    expect(text).toContain('can delay physical removal');
    expect(text).toContain('Generated PDFs use their existing storage');
    expect(text).not.toContain(
      'permanently deletes your workspace, your uploaded',
    );
    expect(body).toContain('Delete my account…');
    expect(body).not.toContain('name="confirmEmail"');
  });

  it('keeps deletion unavailable when disabled', () => {
    const { body } = render(AccountPage, {
      props: { data: { ...data, deletionEnabled: false }, form: null },
    });
    expect(body).toContain('disabled-message');
    expect(body).not.toContain('Delete my account…');
    expect(body).not.toContain('recoverable for 30 days after deletion');
  });
});
