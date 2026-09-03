import * as SmrtCore from '@happyvertical/smrt-core';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const coreMocks = vi.hoisted(() => ({
  events: [] as string[],
  generateSchemaDiff: vi.fn(async () => {
    coreMocks.events.push('schema-diff');
    return {
      added_tables: [],
      changed_tables: [],
      removed_tables: [],
    };
  }),
  getSQLFromDiff: vi.fn(() => [] as string[]),
  hasActionableChanges: vi.fn(() => false),
  migratePostgresSystemTimestamps: vi.fn(async () => {
    coreMocks.events.push('timestamp-compatibility');
    return [];
  }),
  resolveDatabase: vi.fn(),
}));

vi.mock('@happyvertical/smrt-core', async (importOriginal) => {
  const actual = await importOriginal<typeof SmrtCore>();
  return {
    ...actual,
    generateSchemaDiff: coreMocks.generateSchemaDiff,
    getSQLFromDiff: coreMocks.getSQLFromDiff,
    hasActionableChanges: coreMocks.hasActionableChanges,
    migratePostgresSystemTimestamps:
      coreMocks.migratePostgresSystemTimestamps,
    resolveDatabase: coreMocks.resolveDatabase,
  };
});

import {
  getPendingSchemaStatements,
  migrateSmrtDatabase,
  prepareSmrtDatabaseCompatibility,
  withSmrtDatabaseMigrationLock,
} from './db-common.js';

const database = { type: 'postgres' } as never;

function createDeferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function createAdvisoryLockDatabase(
  events: string[],
  onWait?: () => void,
) {
  let lockHeld = false;
  let sessionCount = 0;
  const waiters: Array<() => void> = [];
  const acquireSession = vi.fn(async () => {
    const sessionId = ++sessionCount;
    let ownsLock = false;

    return {
      query: vi.fn(async (sql: string) => {
        if (!sql.includes('pg_advisory_lock')) {
          return { rows: [], rowCount: 0 };
        }

        events.push(`session-${sessionId}:lock-request`);
        if (lockHeld) {
          events.push(`session-${sessionId}:waiting`);
          onWait?.();
          await new Promise<void>((resolve) => waiters.push(resolve));
        }

        lockHeld = true;
        ownsLock = true;
        events.push(`session-${sessionId}:lock-acquired`);
        return { rows: [], rowCount: 1 };
      }),
      isActive: () => true,
      release: vi.fn(async () => {
        events.push(`session-${sessionId}:released`);
        if (!ownsLock) return;

        ownsLock = false;
        lockHeld = false;
        waiters.shift()?.();
      }),
    };
  });

  return {
    acquireSession,
    database: { acquireSession } as never,
  };
}

beforeEach(() => {
  coreMocks.events.length = 0;
  vi.clearAllMocks();
});

describe('SMRT database timestamp compatibility', () => {
  it('orders new PostgreSQL tables before foreign-key dependents', async () => {
    coreMocks.generateSchemaDiff.mockResolvedValueOnce({
      added_tables: [
        {
          tableName: 'nostr_identities',
          columns: {
            id: { type: 'UUID', primaryKey: true },
            profile_id: { type: 'UUID' },
          },
          dependencies: ['profiles'],
          foreignKeys: [
            {
              column: 'profile_id',
              referencesTable: 'profiles',
              referencesColumn: 'id',
            },
          ],
          indexes: [],
          triggers: [],
          version: '1',
        },
        {
          tableName: 'profiles',
          columns: { id: { type: 'UUID', primaryKey: true } },
          dependencies: [],
          foreignKeys: [],
          indexes: [],
          triggers: [],
          version: '1',
        },
      ],
      changed_tables: [],
      removed_tables: [],
    } as never);
    coreMocks.hasActionableChanges.mockReturnValueOnce(true);

    const pending = await getPendingSchemaStatements(database);
    const profileStatement = pending.statements.findIndex((statement) =>
      statement.includes('CREATE TABLE IF NOT EXISTS "profiles"'),
    );
    const nostrStatement = pending.statements.findIndex((statement) =>
      statement.includes('CREATE TABLE IF NOT EXISTS "nostr_identities"'),
    );

    expect(profileStatement).toBeGreaterThanOrEqual(0);
    expect(nostrStatement).toBeGreaterThan(profileStatement);
  });

  it('runs the upstream UTC migration before the migration schema diff', async () => {
    await migrateSmrtDatabase(database);

    expect(coreMocks.events).toEqual([
      'timestamp-compatibility',
      'schema-diff',
    ]);
    expect(coreMocks.migratePostgresSystemTimestamps).toHaveBeenCalledWith(
      database,
      { legacyTimezone: 'UTC' },
    );
  });

  it('keeps pending schema inspection read-only', async () => {
    await getPendingSchemaStatements(database);

    expect(coreMocks.events).toEqual(['schema-diff']);
    expect(coreMocks.migratePostgresSystemTimestamps).not.toHaveBeenCalled();
  });

  it('passes explicit UTC provenance at each mutation boundary', async () => {
    await prepareSmrtDatabaseCompatibility(database);
    await prepareSmrtDatabaseCompatibility(database);

    expect(coreMocks.migratePostgresSystemTimestamps).toHaveBeenCalledTimes(2);
    expect(coreMocks.migratePostgresSystemTimestamps).toHaveBeenNthCalledWith(
      1,
      database,
      { legacyTimezone: 'UTC' },
    );
    expect(coreMocks.migratePostgresSystemTimestamps).toHaveBeenNthCalledWith(
      2,
      database,
      { legacyTimezone: 'UTC' },
    );
  });
});

describe('SMRT database migration lock', () => {
  it('serializes concurrent startup work and rechecks schema after waiting', async () => {
    const events: string[] = [];
    const firstCanFinish = createDeferred();
    const firstEntered = createDeferred();
    const secondWaiting = createDeferred();
    const { database: lockedDatabase } = createAdvisoryLockDatabase(
      events,
      secondWaiting.resolve,
    );
    let backfillApplied = false;

    coreMocks.getSQLFromDiff
      .mockReturnValueOnce(['ALTER TABLE profiles ADD COLUMN email_key TEXT'])
      .mockReturnValueOnce([]);
    coreMocks.hasActionableChanges.mockReturnValueOnce(true).mockReturnValueOnce(false);

    const runStartupMigration = async (name: 'first' | 'second') =>
      await withSmrtDatabaseMigrationLock(async (db) => {
        await prepareSmrtDatabaseCompatibility(db);
        const pending = await getPendingSchemaStatements(db);
        events.push(`${name}:diff`);
        if (pending.hasChanges && pending.statements.length > 0) {
          events.push(`${name}:apply`);
        }

        events.push(`${name}:backfill-check`);
        if (!backfillApplied) {
          backfillApplied = true;
          events.push(`${name}:backfill-apply`);
        }
        if (name === 'first') {
          firstEntered.resolve();
          await firstCanFinish.promise;
        }
      }, lockedDatabase);

    const first = runStartupMigration('first');
    await firstEntered.promise;

    const second = runStartupMigration('second');
    await secondWaiting.promise;
    expect(events).toContain('first:apply');
    expect(events).toContain('first:backfill-apply');
    expect(events).not.toContain('second:diff');
    expect(events).not.toContain('second:apply');
    expect(events).not.toContain('second:backfill-check');
    expect(events).not.toContain('second:backfill-apply');

    firstCanFinish.resolve();
    await first;
    await second;

    expect(events).toContain('second:diff');
    expect(events).not.toContain('second:apply');
    expect(events).toContain('second:backfill-check');
    expect(events).not.toContain('second:backfill-apply');
    expect(coreMocks.generateSchemaDiff).toHaveBeenCalledTimes(2);
    expect(coreMocks.hasActionableChanges).toHaveBeenCalledTimes(2);
  });

  it('releases the advisory-lock session when startup work fails', async () => {
    const release = vi.fn(async () => {});
    const query = vi.fn(async () => ({ rows: [], rowCount: 0 }));
    const lockedDatabase = {
      acquireSession: vi.fn(async () => ({
        query,
        isActive: () => true,
        release,
      })),
    } as never;

    await expect(
      withSmrtDatabaseMigrationLock(async () => {
        throw new Error('startup migration failed');
      }, lockedDatabase),
    ).rejects.toThrow('startup migration failed');

    expect(query).toHaveBeenNthCalledWith(
      1,
      "SELECT set_config('lock_timeout', $1, false)",
      ['120s'],
    );
    expect(query).toHaveBeenNthCalledWith(
      2,
      "SELECT set_config('statement_timeout', $1, false)",
      ['125s'],
    );
    expect(query).toHaveBeenNthCalledWith(
      3,
      'SELECT pg_advisory_lock(hashtext($1))',
      ['@willgriffin/iolaus-site:smrt-database-migration'],
    );
    expect(release).toHaveBeenCalledOnce();
  });
});
