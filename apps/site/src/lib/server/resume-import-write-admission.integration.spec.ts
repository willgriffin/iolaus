import { randomUUID } from 'node:crypto';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getTestDatabase } from '@happyvertical/smrt-core';
import { getDatabase } from '@happyvertical/sql';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  type AccountDeletionDialect,
  deleteAccount,
} from './account-deletion.js';
import { insert } from './fixtures/account-seed.js';
import {
  beginResumeImportWrite,
  lockResumeImportAccount,
  pendingResumeImportWrites,
  resolveResumeImportWrite,
} from './resume-import-write-admission.js';
import './smrt.js';

type Db = Awaited<ReturnType<typeof getTestDatabase>>;
const classes = [
  'ResumeImportWriteOperation',
  'AccountDeletionRecord',
  'CandidateProfile',
  'User',
  'Tenant',
  'Membership',
  'Profile',
  'Role',
];
const shared = {
  IOLAUS_WORKSPACE_MODE: 'shared',
  SMRT_APP_ID: 'beta-app',
  SMRT_RUNTIME_PROFILE: 'self-hosted',
};
function transaction<T>(db: Db, work: (tx: Db) => Promise<T>): Promise<T> {
  if (!db.transaction) throw new Error('Expected native transactions.');
  return db.transaction(work);
}
const locator = {
  sourceId: 'iolaus-resume-upload:fictional',
  deliveryKey: 'fictional-pdf-hash',
};
async function seed(db: Db) {
  const scope = {
    tenantId: randomUUID(),
    userId: randomUUID(),
    profileId: randomUUID(),
  };
  const roleId = randomUUID();
  const personProfileId = randomUUID();
  await insert(db, 'tenants', { id: scope.tenantId, status: 'active' });
  await insert(db, 'profiles', { id: personProfileId, _meta_type: 'person' });
  await insert(db, 'roles', { id: roleId, name: roleId });
  await insert(db, 'users', {
    id: scope.userId,
    profile_id: personProfileId,
    email: `${scope.userId}@example.invalid`,
    email_key: scope.userId,
    status: 'active',
  });
  await insert(db, 'memberships', {
    user_id: scope.userId,
    tenant_id: scope.tenantId,
    role_id: roleId,
    status: 'active',
  });
  await insert(db, 'candidate_profiles', {
    id: scope.profileId,
    tenant_id: scope.tenantId,
    owner_user_id: scope.userId,
    profile_key: 'default',
  });
  return scope;
}
function contract(create: () => Promise<Db>, dialect: AccountDeletionDialect) {
  if (dialect === 'postgres')
    it('qualifies the published UUID identity and text candidate-ownership schema boundary', async () => {
      const db = await create();
      const columns = (
        await db.query(
          `SELECT table_name, column_name, data_type FROM information_schema.columns
          WHERE table_schema = current_schema()
            AND table_name IN ('users', 'memberships', 'tenants', 'candidate_profiles')`,
        )
      ).rows as Array<{
        table_name: string;
        column_name: string;
        data_type: string;
      }>;
      const type = (table: string, column: string) =>
        columns.find(
          (entry) => entry.table_name === table && entry.column_name === column,
        )?.data_type;
      for (const [table, column] of [
        ['users', 'id'],
        ['tenants', 'id'],
        ['memberships', 'user_id'],
        ['memberships', 'tenant_id'],
      ])
        expect(type(table, column)).toBe('uuid');
      expect(type('candidate_profiles', 'owner_user_id')).toBe('text');
      expect(type('candidate_profiles', 'tenant_id')).toBe('text');
      const scope = await seed(db);
      await beginResumeImportWrite(db, scope, locator);
      expect(await pendingResumeImportWrites(db, scope)).toBe(1);
    });

  it('commits separate markers for repeated delivery; closure persists pending without purging or erasing recovery identities', async () => {
    const db = await create();
    const scope = await seed(db);
    const other = await seed(db);
    const first = await beginResumeImportWrite(db, scope, locator);
    const second = await beginResumeImportWrite(db, scope, locator);
    expect(first).not.toBe(second);
    expect(await pendingResumeImportWrites(db, scope)).toBe(2);
    const purge = vi.fn(async () => 0);
    const deletion = () =>
      deleteAccount(scope, {
        database: db,
        dialect,
        environment: shared,
        purgeResumeImports: purge,
      });
    for (let attempt = 0; attempt < 2; attempt++)
      await expect(deletion()).rejects.toMatchObject({
        code: 'pending-source-writes',
      });
    expect(purge).not.toHaveBeenCalled();
    expect(
      (await db.query('SELECT id FROM users WHERE id = ?', [scope.userId]))
        .rows,
    ).toHaveLength(1);
    expect(
      (
        await db.query(
          "SELECT id FROM account_deletion_records WHERE tenant_id = ? AND user_id = ? AND status = 'started'",
          [scope.tenantId, scope.userId],
        )
      ).rows,
    ).toHaveLength(1);
    await expect(beginResumeImportWrite(db, scope, locator)).rejects.toThrow(
      'deletion has started',
    );
    const independent = await beginResumeImportWrite(db, other, locator);
    await expect(resolveResumeImportWrite(db, other, first)).rejects.toThrow(
      'marker is unavailable',
    );
    expect(await pendingResumeImportWrites(db, scope)).toBe(2);
    await resolveResumeImportWrite(db, scope, first);
    await expect(deletion()).rejects.toMatchObject({
      code: 'pending-source-writes',
    });
    await resolveResumeImportWrite(db, scope, second);
    expect((await deletion()).status).toBe('deleted');
    expect(purge).toHaveBeenCalledOnce();
    await expect(beginResumeImportWrite(db, scope, locator)).rejects.toThrow(
      'unavailable',
    );
    expect((await deletion()).status).toBe('already-deleted');
    expect(await pendingResumeImportWrites(db, other)).toBe(1);
    await resolveResumeImportWrite(db, other, independent);
  });
  it('serializes queued admission behind committed closure, and allows it after closure rollback', async () => {
    const db = await create();
    const scope = await seed(db);
    for (const commit of [false, true]) {
      let release!: () => void;
      let locked!: () => void;
      const held = new Promise<void>((resolve) => {
        locked = resolve;
      });
      const released = new Promise<void>((resolve) => {
        release = resolve;
      });
      const closing = transaction(db, async (tx) => {
        await lockResumeImportAccount(tx, scope, dialect);
        locked();
        await released;
        await insert(tx as Db, 'account_deletion_records', {
          status: 'started',
          tenant_id: scope.tenantId,
          user_id: scope.userId,
          ledger_pseudonym: randomUUID(),
          initiated_by: 'operator',
          summary: '',
        });
        if (!commit) throw new Error('closure rolled back');
      });
      const closed = closing.catch((error) => {
        if (commit) throw error;
      });
      await held;
      const incoming = beginResumeImportWrite(db, scope, locator);
      // Attach a rejection observer before releasing the ordinary transaction.
      const observed = incoming.then(
        (id) => ({ id }),
        (error: Error) => ({ error }),
      );
      release();
      await closed;
      const result = await observed;
      if (commit) {
        expect(result).toMatchObject({
          error: expect.objectContaining({
            message: expect.stringContaining('deletion has started'),
          }),
        });
      } else {
        expect(result).toHaveProperty('id');
        if ('id' in result)
          await resolveResumeImportWrite(db, scope, result.id);
      }
    }
  });
  it('requires extant active tenant, owner, profile and membership', async () => {
    const db = await create();
    const scope = await seed(db);
    const other = await seed(db);
    const person = (
      await db.query('SELECT profile_id FROM users WHERE id = ?', [
        scope.userId,
      ])
    ).rows[0] as { profile_id: string };
    expect(person.profile_id).not.toBe(scope.profileId);
    await expect(
      beginResumeImportWrite(
        db,
        { ...scope, profileId: person.profile_id },
        locator,
      ),
    ).rejects.toThrow('unavailable');
    for (const invalid of [
      { ...scope, tenantId: other.tenantId },
      { ...scope, profileId: other.profileId },
      { ...scope, userId: other.userId },
    ])
      await expect(
        beginResumeImportWrite(db, invalid, locator),
      ).rejects.toThrow('unavailable');
    for (const [table, predicate, values] of [
      ['users', 'id = ?', [scope.userId]],
      ['tenants', 'id = ?', [scope.tenantId]],
      [
        'memberships',
        'user_id = ? AND tenant_id = ?',
        [scope.userId, scope.tenantId],
      ],
    ] as const) {
      await db.query(
        `UPDATE ${table} SET status = 'inactive' WHERE ${predicate}`,
        [...values],
      );
      await expect(beginResumeImportWrite(db, scope, locator)).rejects.toThrow(
        'unavailable',
      );
      await db.query(
        `UPDATE ${table} SET status = 'active' WHERE ${predicate}`,
        [...values],
      );
    }
    await db.query(
      'UPDATE candidate_profiles SET owner_user_id = ? WHERE id = ?',
      [other.userId, scope.profileId],
    );
    await expect(beginResumeImportWrite(db, scope, locator)).rejects.toThrow(
      'unavailable',
    );
    await db.query(
      'UPDATE candidate_profiles SET owner_user_id = ?, tenant_id = ? WHERE id = ?',
      [scope.userId, other.tenantId, scope.profileId],
    );
    await expect(beginResumeImportWrite(db, scope, locator)).rejects.toThrow(
      'unavailable',
    );
    await db.query('UPDATE candidate_profiles SET tenant_id = ? WHERE id = ?', [
      scope.tenantId,
      scope.profileId,
    ]);
    expect(await pendingResumeImportWrites(db, scope)).toBe(0);
    await beginResumeImportWrite(db, scope, locator);
    expect(await pendingResumeImportWrites(db, scope)).toBe(1);
  });
  it('does not report already deleted when unresolved evidence survives missing identities', async () => {
    const db = await create();
    const scope = await seed(db);
    await beginResumeImportWrite(db, scope, locator);
    await db.query('DELETE FROM memberships WHERE user_id = ?', [scope.userId]);
    await db.query('DELETE FROM users WHERE id = ?', [scope.userId]);
    await db.query('DELETE FROM tenants WHERE id = ?', [scope.tenantId]);
    await expect(
      deleteAccount(scope, {
        database: db,
        dialect,
        environment: shared,
        purgeResumeImports: async () => 0,
      }),
    ).rejects.toMatchObject({ code: 'pending-source-writes' });
    expect(await pendingResumeImportWrites(db, scope)).toBe(1);
  });
  it('rolls back an uncommitted admission and fails closed without the ledger', async () => {
    const db = await create();
    const scope = await seed(db);
    const aborting = {
      url: db.url,
      query: db.query.bind(db),
      transaction: async <T>(work: (tx: Db) => Promise<T>) =>
        transaction(db, async (tx) => {
          await work(tx);
          throw new Error('abort admission');
        }),
    };
    await expect(
      beginResumeImportWrite(aborting, scope, locator),
    ).rejects.toThrow('abort admission');
    expect(await pendingResumeImportWrites(db, scope)).toBe(0);
    await db.query('DROP TABLE resume_import_write_operations');
    await expect(beginResumeImportWrite(db, scope, locator)).rejects.toThrow();
    const purge = vi.fn(async () => 0);
    await expect(
      deleteAccount(scope, {
        database: db,
        dialect,
        environment: shared,
        purgeResumeImports: purge,
      }),
    ).rejects.toThrow();
    expect(purge).not.toHaveBeenCalled();
    expect(
      (await db.query('SELECT id FROM users WHERE id = ?', [scope.userId]))
        .rows,
    ).toHaveLength(1);
  });
}

describe('durable private write admission on SQLite', () => {
  const resources: { db: Db; path: string }[] = [];
  afterEach(async () => {
    for (const { db, path } of resources.splice(0)) {
      await db.close?.();
      await rm(path, { force: true });
    }
  });
  contract(async () => {
    const path = join(tmpdir(), `iolaus-write-${randomUUID()}.sqlite`);
    const db = await getTestDatabase({ classes, url: path });
    resources.push({ db, path });
    return db;
  }, 'sqlite');
});

const postgresUrl =
  process.env.RESUME_WRITE_ADMISSION_POSTGRES_TEST_DATABASE_URL?.trim();
describe.runIf(postgresUrl)(
  'ordinary durable private write admission on PostgreSQL',
  () => {
    const resources: { db: Db; schema: string }[] = [];
    afterEach(async () => {
      for (const { db, schema } of resources.splice(0)) {
        await db.query(`DROP SCHEMA "${schema}" CASCADE`);
        await db.close?.();
      }
    });
    contract(async () => {
      const schema = `write_admission_${randomUUID().replaceAll('-', '')}`;
      if (!postgresUrl) throw new Error('Expected a PostgreSQL test URL.');
      const url = new URL(postgresUrl);
      if (url.pathname !== '/iolaus_resume_import_qa')
        throw new Error(
          'Use the isolated iolaus_resume_import_qa test database.',
        );
      url.searchParams.set('options', `-c search_path=${schema}`);
      const db = await getDatabase({
        cache: false,
        type: 'postgres',
        url: url.toString(),
        max: 5,
      });
      await db.query(`CREATE SCHEMA "${schema}"`);
      resources.push({ db, schema });
      return await getTestDatabase({ db, classes });
    }, 'postgres');
  },
);
