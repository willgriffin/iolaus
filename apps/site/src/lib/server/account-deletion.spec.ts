import { describe, expect, it } from 'vitest';
import {
  ACCOUNT_DELETION_CONFIRMATION_PHRASE,
  type AccountDeletionDatabase,
  AccountDeletionError,
  accountDeletionConfirmed,
  accountDeletionMode,
  accountOwnedTables,
  deleteAccount,
} from './account-deletion';
import { workspaceOwnershipTables } from './workspace-ownership-backfill.js';

const shared = {
  IOLAUS_WORKSPACE_MODE: 'shared',
  SMRT_APP_ID: 'beta-app',
  SMRT_RUNTIME_PROFILE: 'self-hosted',
};

describe('account deletion policy', () => {
  it('is enabled only for shared hosted installations', () => {
    expect(accountDeletionMode(shared)).toBe('enabled');
    expect(accountDeletionMode({})).toBe('disabled');
    expect(
      accountDeletionMode({
        IOLAUS_WORKSPACE_MODE: 'private',
        SMRT_APP_ID: 'beta-app',
        SMRT_RUNTIME_PROFILE: 'self-hosted',
      }),
    ).toBe('disabled');
    // The local profile is always private regardless of the mode variable.
    expect(
      accountDeletionMode({
        IOLAUS_WORKSPACE_MODE: 'shared',
        SMRT_RUNTIME_PROFILE: 'local',
      }),
    ).toBe('disabled');
  });

  it('refuses to run in private mode, before touching the database', async () => {
    const queries: string[] = [];
    const database: AccountDeletionDatabase = {
      query: async (sql) => {
        queries.push(sql);
        return { rows: [] };
      },
      transaction: async (work) => await work(database),
    };
    await expect(
      deleteAccount(
        { tenantId: 't', userId: 'u' },
        { database, dialect: 'sqlite', environment: {} },
      ),
    ).rejects.toMatchObject({ code: 'disabled' });
    expect(queries).toEqual([]);
  });

  it('rejects a blank or malformed scope', async () => {
    const database: AccountDeletionDatabase = {
      query: async () => ({ rows: [] }),
      transaction: async (work) => await work(database),
    };
    for (const scope of [
      { tenantId: '', userId: 'u' },
      { tenantId: 't', userId: ' u ' },
      { tenantId: 't', userId: 'u\n' },
    ]) {
      await expect(
        deleteAccount(scope, {
          database,
          dialect: 'sqlite',
          environment: shared,
        }),
      ).rejects.toBeInstanceOf(AccountDeletionError);
    }
  });

  it('requires the email and the exact phrase', () => {
    const email = 'Person@Example.invalid';
    const phrase = ACCOUNT_DELETION_CONFIRMATION_PHRASE;
    expect(
      accountDeletionConfirmed({
        email,
        typedEmail: ' person@example.invalid ',
        typedPhrase: phrase,
      }),
    ).toBe(true);
    expect(
      accountDeletionConfirmed({
        email,
        typedEmail: 'other@example.invalid',
        typedPhrase: phrase,
      }),
    ).toBe(false);
    expect(
      accountDeletionConfirmed({
        email,
        typedEmail: email,
        typedPhrase: phrase.toLowerCase(),
      }),
    ).toBe(false);
    expect(
      accountDeletionConfirmed({
        email: '',
        typedEmail: '',
        typedPhrase: phrase,
      }),
    ).toBe(false);
  });

  it('covers every candidate-owned ownership table', () => {
    for (const table of workspaceOwnershipTables) {
      expect(accountOwnedTables).toContain(table);
    }
    expect(accountOwnedTables).toContain('admin_assistant_turns');
    expect(accountOwnedTables).toContain('opportunity_recommendation_ranks');
  });
});
