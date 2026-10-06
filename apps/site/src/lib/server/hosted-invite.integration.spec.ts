import { randomUUID } from 'node:crypto';
import { getTestDatabase } from '@happyvertical/smrt-core';
import { type DatabaseInterface, getDatabase } from '@happyvertical/sql';
import { afterEach, describe, expect, it } from 'vitest';
import {
  addInvite,
  isEmailInvited,
  listInvites,
  normalizeInviteEmail,
  revokeInvite,
} from './hosted-invite';
import './smrt.js';

type TestDatabase = Awaited<ReturnType<typeof getTestDatabase>>;

/**
 * The same behavioural contract on every supported engine: an uninvited
 * address is rejected, an invited one admitted case-insensitively, and a
 * revocation is visible on the very next read -- which is what ends an
 * existing session, because the request guard re-reads this on every request.
 */
function inviteContract(open: () => Promise<TestDatabase>) {
  let db: TestDatabase | undefined;
  afterEach(async () => {
    await db?.close?.();
    db = undefined;
  });
  async function store() {
    db = await open();
    return { db };
  }

  it('rejects an uninvited address and blank input', async () => {
    const options = await store();
    expect(await isEmailInvited('stranger@example.invalid', options)).toBe(
      false,
    );
    expect(await isEmailInvited('', options)).toBe(false);
    expect(await isEmailInvited(undefined, options)).toBe(false);
  });

  it('admits an invited address regardless of case or padding', async () => {
    const options = await store();
    await expect(
      addInvite('  Friend@Example.INVALID ', options),
    ).resolves.toEqual({ email: 'friend@example.invalid', result: 'created' });
    expect(await isEmailInvited('FRIEND@example.invalid', options)).toBe(true);
    expect(await isEmailInvited(' friend@example.invalid ', options)).toBe(
      true,
    );
    expect(await isEmailInvited('other@example.invalid', options)).toBe(false);
  });

  it('is idempotent and never duplicates an invitation', async () => {
    const options = await store();
    await addInvite('friend@example.invalid', options);
    await expect(
      addInvite('FRIEND@example.invalid', options),
    ).resolves.toMatchObject({ result: 'unchanged' });
    expect(await listInvites(options)).toEqual([
      { email: 'friend@example.invalid', status: 'invited' },
    ]);
  });

  it('rejects a revoked address on the next check and reinstates on re-invite', async () => {
    const options = await store();
    await addInvite('friend@example.invalid', options);
    expect(await isEmailInvited('friend@example.invalid', options)).toBe(true);

    await expect(
      revokeInvite('Friend@example.invalid', options),
    ).resolves.toMatchObject({ result: 'revoked' });
    expect(await isEmailInvited('friend@example.invalid', options)).toBe(false);
    expect(await listInvites(options)).toEqual([
      { email: 'friend@example.invalid', status: 'revoked' },
    ]);
    await expect(
      revokeInvite('friend@example.invalid', options),
    ).resolves.toMatchObject({ result: 'unchanged' });

    await expect(
      addInvite('friend@example.invalid', options),
    ).resolves.toMatchObject({ result: 'reinstated' });
    expect(await isEmailInvited('friend@example.invalid', options)).toBe(true);
  });

  it('reports an unknown revocation and rejects malformed addresses', async () => {
    const options = await store();
    await expect(
      revokeInvite('nobody@example.invalid', options),
    ).resolves.toMatchObject({ result: 'not-found' });
    await expect(addInvite('not-an-email', options)).rejects.toThrow(
      /valid email/u,
    );
  });
}

describe('hosted invite store on SQLite', () => {
  inviteContract(
    async () => await getTestDatabase({ classes: ['HostedInvite'] }),
  );

  it('normalizes emails the same way private-mode admin emails are', () => {
    expect(normalizeInviteEmail('  A@B.Example ')).toBe('a@b.example');
    expect(normalizeInviteEmail(undefined)).toBe('');
  });
});

const postgresUrl =
  process.env.HOSTED_INVITE_POSTGRES_TEST_DATABASE_URL?.trim();

function quoteIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

describe.runIf(postgresUrl)('hosted invite store on PostgreSQL', () => {
  const databases: string[] = [];
  let control: DatabaseInterface | undefined;

  afterEach(async () => {
    for (const name of databases.splice(0)) {
      await control?.query(
        `DROP DATABASE IF EXISTS ${quoteIdentifier(name)} WITH (FORCE)`,
      );
    }
    await control?.close?.();
    control = undefined;
  });

  inviteContract(async () => {
    if (!postgresUrl) throw new Error('Expected a PostgreSQL test URL.');
    control = await getDatabase({
      cache: false,
      type: 'postgres',
      url: postgresUrl,
    });
    const name = `iolaus_invite_${randomUUID().replaceAll('-', '')}`;
    databases.push(name);
    await control.query(`CREATE DATABASE ${quoteIdentifier(name)}`);
    const url = new URL(postgresUrl);
    url.pathname = `/${name}`;
    const db = await getDatabase({
      cache: false,
      type: 'postgres',
      url: url.toString(),
    });
    return await getTestDatabase({ db, classes: ['HostedInvite'] });
  });
});
