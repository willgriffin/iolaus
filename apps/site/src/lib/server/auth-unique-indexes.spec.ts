import { describe, expect, it, vi } from 'vitest';
import {
  AUTH_UNIQUE_INDEXES,
  ensureNativeAuthUniqueIndexes,
} from './auth-unique-indexes.js';

describe('native auth uniqueness compatibility', () => {
  it('preflights, creates, and verifies every exact auth index under one locked session', async () => {
    const query = vi.fn(async () => ({ rows: [] }));
    const release = vi.fn(async () => undefined);

    await ensureNativeAuthUniqueIndexes({
      acquireSession: vi.fn(async () => ({ query, release })),
    } as never);

    expect(query).toHaveBeenNthCalledWith(1, 'BEGIN');
    expect(query).toHaveBeenNthCalledWith(
      2,
      "SELECT set_config('lock_timeout', $1, true)",
      ['15s'],
    );
    expect(query).toHaveBeenNthCalledWith(
      3,
      "SELECT set_config('statement_timeout', $1, true)",
      ['60s'],
    );
    expect(query).toHaveBeenNthCalledWith(
      4,
      'LOCK TABLE "users" IN ACCESS EXCLUSIVE MODE',
    );
    expect(query).toHaveBeenNthCalledWith(
      5,
      'LOCK TABLE "users_cli_auth_requests" IN ACCESS EXCLUSIVE MODE',
    );

    for (const { column, index, table } of AUTH_UNIQUE_INDEXES) {
      expect(query).toHaveBeenCalledWith(
        expect.stringContaining('duplicate non-null values exist'),
      );
      expect(query).toHaveBeenCalledWith(
        expect.stringContaining('index_definition.indimmediate'),
      );
      expect(query).toHaveBeenCalledWith(
        expect.stringContaining(`CREATE UNIQUE INDEX IF NOT EXISTS "${index}"`),
      );
      expect(query).toHaveBeenCalledWith(
        expect.stringContaining(`Missing valid unique auth index % for %.%`),
      );
      expect(table).toMatch(/^(users|users_cli_auth_requests)$/);
      expect(column).toMatch(/^(profile_id|device_code_hash|user_code)$/);
    }
    expect(query).toHaveBeenLastCalledWith('COMMIT');
    expect(release).toHaveBeenCalledOnce();
  });

  it.each(
    AUTH_UNIQUE_INDEXES.slice(1),
  )('rolls back before any DDL when the $column preflight fails', async ({
    column,
  }) => {
    const query = vi.fn(async (sql: string) => {
      if (
        sql.includes('duplicate non-null values exist') &&
        sql.includes(`'${column}'`)
      ) {
        throw new Error('duplicate non-null values exist');
      }
      return { rows: [] };
    });
    const release = vi.fn(async () => undefined);

    await expect(
      ensureNativeAuthUniqueIndexes({
        acquireSession: vi.fn(async () => ({ query, release })),
      } as never),
    ).rejects.toThrow('duplicate non-null values exist');

    expect(query).not.toHaveBeenCalledWith(
      expect.stringContaining('CREATE UNIQUE INDEX'),
    );
    expect(query).toHaveBeenLastCalledWith('ROLLBACK');
    expect(release).toHaveBeenCalledOnce();
  });
});
