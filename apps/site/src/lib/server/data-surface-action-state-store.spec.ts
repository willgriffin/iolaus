import type { DataSurfaceActionResult } from '@happyvertical/smrt-ui/data';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SmrtDataSurfaceActionStateStore } from './data-surface-action-state-store.js';

/**
 * A minimal PostgreSQL stand-in for the two tables the store owns.
 *
 * The store's guarantees are expressed as conditional single statements, so
 * the parts worth asserting here are which statement shape is issued and what
 * the store concludes from the rows it affects.
 *
 * This stand-in cannot tell whether the statements are valid against the real
 * schema -- a wrong column name, an unbindable type, or an `ON CONFLICT`
 * target with no unique index all parse fine here. That is what
 * `data-surface-action-state-store.integration.spec.ts` is for; it runs the
 * same statements against PostgreSQL under
 * `pnpm --filter @willgriffin/iolaus-site test:data-surface-store:db`.
 */
function createFakeDatabase() {
  const tokens = new Map<string, Record<string, unknown>>();
  const idempotency = new Map<string, Record<string, unknown>>();
  const statements: string[] = [];
  /**
   * Stands in for the server-side `CURRENT_TIMESTAMP` the store compares
   * `expires_at` against. Held here rather than read from the process clock so
   * a test can move the database's own clock past a token's deadline.
   */
  const clock = { now: Date.parse('2026-09-02T08:00:00.000Z') };

  const query = vi.fn(async (sql: string, ...values: unknown[]) => {
    statements.push(sql);
    const normalized = sql.replace(/\s+/gu, ' ').trim();

    if (normalized.startsWith('INSERT INTO data_surface_preview_tokens')) {
      const [token] = values as [string];
      if (!tokens.has(token)) {
        tokens.set(token, {
          id: `token-row-${tokens.size}`,
          token,
          expires_at: values[1],
          actor_user_id: values[2],
          tenant_id: values[3],
          on_behalf_of_user_id: values[4],
          acts_as_profile_id: values[5],
          agent_class: values[6],
          identity_key: values[7],
          action_id: values[8],
          action_fingerprint: values[9],
          revision: values[10],
          query_fingerprint: values[11],
          selection_fingerprint: values[12],
          resolved_rows_fingerprint: values[13],
          request_fingerprint: values[14],
          consumed_by: values[15],
        });
      }
      return { rows: [], rowCount: 0 };
    }

    if (normalized.startsWith('SELECT * FROM data_surface_preview_tokens')) {
      const row = tokens.get(values[0] as string);
      return { rows: row ? [row] : [], rowCount: row ? 1 : 0 };
    }

    if (normalized.startsWith('UPDATE data_surface_preview_tokens')) {
      const [token, key] = values as [string, string];
      const row = tokens.get(token);
      if (!row) return { rows: [], rowCount: 0 };
      if (row.consumed_by !== '' && row.consumed_by !== key) {
        return { rows: [], rowCount: 0 };
      }
      // A first consumption also has to beat the deadline; a re-presentation
      // by the same key does not, so an interrupted apply stays retryable.
      if (row.consumed_by === '' && !(epochOf(row.expires_at) > clock.now)) {
        return { rows: [], rowCount: 0 };
      }
      row.consumed_by = key;
      return { rows: [], rowCount: 1 };
    }

    if (normalized.startsWith('DELETE FROM data_surface_preview_tokens')) {
      return { rows: [], rowCount: 0 };
    }

    if (normalized.startsWith('INSERT INTO data_surface_idempotency')) {
      const [key, requestFingerprint, ownerToken, reservedAt] = values as [
        string,
        string,
        string,
        Date,
      ];
      if (idempotency.has(key)) return { rows: [], rowCount: 0 };
      const row = {
        id: `idem-row-${idempotency.size}`,
        scope_key: key,
        status: 'reserved',
        request_fingerprint: requestFingerprint,
        owner_token: ownerToken,
        reserved_at: reservedAt,
        result: null,
      };
      idempotency.set(key, row);
      return { rows: [row], rowCount: 1 };
    }

    if (normalized.startsWith('SELECT * FROM data_surface_idempotency')) {
      const row = idempotency.get(values[0] as string);
      return { rows: row ? [row] : [], rowCount: row ? 1 : 0 };
    }

    if (normalized.startsWith('UPDATE data_surface_idempotency')) {
      const [key, ownerToken, result] = values as [string, string, string];
      const row = idempotency.get(key);
      if (row?.status !== 'reserved' || row.owner_token !== ownerToken) {
        return { rows: [], rowCount: 0 };
      }
      row.status = 'completed';
      row.result = result;
      return { rows: [], rowCount: 1 };
    }

    if (normalized.startsWith('DELETE FROM data_surface_idempotency')) {
      const [key, ownerToken] = values as [string, string];
      const row = idempotency.get(key);
      if (row?.status !== 'reserved' || row.owner_token !== ownerToken) {
        return { rows: [], rowCount: 0 };
      }
      idempotency.delete(key);
      return { rows: [], rowCount: 1 };
    }

    throw new Error(`unexpected statement: ${normalized}`);
  });

  return {
    clock,
    db: { query } as never,
    idempotency,
    query,
    statements,
    tokens,
  };
}

/** `expires_at` reaches the fake as whatever the store bound; normalize it. */
function epochOf(value: unknown): number {
  if (value instanceof Date) return value.getTime();
  return Date.parse(String(value ?? ''));
}

const tokenRecord = {
  expiresAt: Date.parse('2026-09-02T09:00:00.000Z'),
  actorUserId: 'user-1',
  tenantId: null,
  onBehalfOfUserId: null,
  actsAsProfileId: null,
  agentClass: 'iolaus.localhost/owner',
  identityKey: 'admin-opportunities:table',
  actionId: 'review',
  actionFingerprint: 'action-fp',
  revision: 0,
  queryFingerprint: 'query-fp',
  selectionFingerprint: 'selection-fp',
  resolvedRowsFingerprint: 'rows-fp',
  requestFingerprint: 'request-fp',
};

const result = {
  status: 'applied',
  details: { count: 2 },
} as unknown as DataSurfaceActionResult;

describe('SmrtDataSurfaceActionStateStore', () => {
  let harness: ReturnType<typeof createFakeDatabase>;
  let store: SmrtDataSurfaceActionStateStore;

  beforeEach(() => {
    harness = createFakeDatabase();
    store = new SmrtDataSurfaceActionStateStore(harness.db);
  });

  it('round-trips a preview token through the durable table', async () => {
    await store.putToken('token-1', tokenRecord);

    expect(await store.getToken('token-1')).toEqual({
      ...tokenRecord,
      consumedBy: '',
    });
    expect(await store.getToken('missing')).toBeUndefined();
  });

  it('lets one idempotency key consume a token and refuses any other', async () => {
    await store.putToken('token-1', tokenRecord);

    expect(await store.markTokenConsumed('token-1', 'key-a')).toBe(true);
    // The same key may re-present the token, so an interrupted apply can be
    // retried and still reach its recorded outcome.
    expect(await store.markTokenConsumed('token-1', 'key-a')).toBe(true);
    // A different key is a different decision wearing a used confirmation.
    expect(await store.markTokenConsumed('token-1', 'key-b')).toBe(false);
    expect(await store.markTokenConsumed('missing', 'key-a')).toBe(false);
  });

  it('refuses a first consumption once the token has expired', async () => {
    await store.putToken('token-1', tokenRecord);
    // The adapter checks expiry before awaiting this write and never rechecks
    // afterwards, so the deadline has to hold at the write or a confirmation
    // that lapsed in between would still authorize the apply.
    harness.clock.now = tokenRecord.expiresAt + 1;

    expect(await store.markTokenConsumed('token-1', 'key-a')).toBe(false);
  });

  it('still lets the original key re-present an expired token', async () => {
    await store.putToken('token-1', tokenRecord);
    expect(await store.markTokenConsumed('token-1', 'key-a')).toBe(true);
    harness.clock.now = tokenRecord.expiresAt + 1;

    // The decision was already authorized while the token was live; refusing
    // the retry would strand an interrupted apply short of its recorded
    // outcome without preventing anything.
    expect(await store.markTokenConsumed('token-1', 'key-a')).toBe(true);
    expect(await store.markTokenConsumed('token-1', 'key-b')).toBe(false);
  });

  it('gives the reservation to exactly one concurrent attempt', async () => {
    const [first, second] = await Promise.all([
      store.reserveIdempotency('key-1', {
        requestFingerprint: 'request-fp',
        ownerToken: 'owner-a',
        reservedAt: 1,
      }),
      store.reserveIdempotency('key-1', {
        requestFingerprint: 'request-fp',
        ownerToken: 'owner-b',
        reservedAt: 2,
      }),
    ]);

    const owners = [first, second].map((record) =>
      record.status === 'reserved' ? record.ownerToken : 'completed',
    );
    // Both see the same reservation, and it belongs to whichever insert won.
    expect(new Set(owners).size).toBe(1);
    expect(['owner-a', 'owner-b']).toContain(owners[0]);
  });

  it('only the reservation holder may complete or release the key', async () => {
    await store.reserveIdempotency('key-1', {
      requestFingerprint: 'request-fp',
      ownerToken: 'owner-a',
      reservedAt: 1,
    });

    expect(await store.completeIdempotency('key-1', 'owner-b', result)).toBe(
      false,
    );
    expect(await store.releaseIdempotency('key-1', 'owner-b')).toBe(false);
    expect(await store.completeIdempotency('key-1', 'owner-a', result)).toBe(
      true,
    );
    // A completed key is terminal: it can no longer be completed or released.
    expect(await store.completeIdempotency('key-1', 'owner-a', result)).toBe(
      false,
    );
    expect(await store.releaseIdempotency('key-1', 'owner-a')).toBe(false);
  });

  it('replays the stored result for a completed key', async () => {
    await store.reserveIdempotency('key-1', {
      requestFingerprint: 'request-fp',
      ownerToken: 'owner-a',
      reservedAt: 1,
    });
    await store.completeIdempotency('key-1', 'owner-a', result);

    expect(await store.getIdempotency('key-1')).toEqual({
      status: 'completed',
      requestFingerprint: 'request-fp',
      result,
    });
  });

  it('releasing a reservation frees the key for a later attempt', async () => {
    await store.reserveIdempotency('key-1', {
      requestFingerprint: 'request-fp',
      ownerToken: 'owner-a',
      reservedAt: 1,
    });
    expect(await store.releaseIdempotency('key-1', 'owner-a')).toBe(true);
    expect(await store.getIdempotency('key-1')).toBeUndefined();

    const retry = await store.reserveIdempotency('key-1', {
      requestFingerprint: 'request-fp',
      ownerToken: 'owner-b',
      reservedAt: 3,
    });
    expect(retry).toEqual({
      status: 'reserved',
      requestFingerprint: 'request-fp',
      ownerToken: 'owner-b',
      reservedAt: 3,
    });
  });

  it('never reads a row back before writing it', async () => {
    await store.putToken('token-1', tokenRecord);
    await store.reserveIdempotency('key-1', {
      requestFingerprint: 'request-fp',
      ownerToken: 'owner-a',
      reservedAt: 1,
    });
    await store.completeIdempotency('key-1', 'owner-a', result);

    // Every mutation is one conditional statement. A read-modify-write would
    // both lose the race this store exists to arbitrate and, under SMRT's
    // revision guard, raise a conflict on exactly the contended path.
    const mutations = harness.statements.filter((sql) =>
      /^\s*(INSERT|UPDATE|DELETE)/u.test(sql),
    );
    for (const sql of mutations) {
      expect(sql).toMatch(
        /ON CONFLICT|WHERE .*(status = 'reserved'|consumed_by|expires_at <)/su,
      );
    }
  });
});
