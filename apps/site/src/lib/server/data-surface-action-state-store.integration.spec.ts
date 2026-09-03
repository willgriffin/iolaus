import { randomUUID } from 'node:crypto';
import { resolveDatabase } from '@happyvertical/smrt-core';
import type { DataSurfaceActionResult } from '@happyvertical/smrt-ui/data';
import { beforeAll, describe, expect, it } from 'vitest';
import { SmrtDataSurfaceActionStateStore } from './data-surface-action-state-store.js';

/**
 * The unit spec asserts what the store concludes from the rows a statement
 * affects, against a hand-built stand-in. That cannot catch the class of bug
 * that only a real database reports: a column this file names but the schema
 * does not have, a type the driver will not bind, or an `ON CONFLICT` target
 * with no matching unique index. Those would surface on the first production
 * preview or apply, so exercise the statements themselves here.
 *
 * Opt in with `DATA_SURFACE_STORE_TEST_DATABASE_URL` pointing at a local
 * database whose schema is migrated (`pnpm --filter @willgriffin/iolaus-site
 * db:migrate`), e.g. the development mirror.
 */
const databaseUrl = process.env.DATA_SURFACE_STORE_TEST_DATABASE_URL?.trim();
const enabled = Boolean(databaseUrl);

const result = {
  version: 1,
  status: 'applied',
  details: { count: 2 },
} as unknown as DataSurfaceActionResult;

describe.runIf(enabled)('data surface action state store (postgres)', () => {
  let store: SmrtDataSurfaceActionStateStore;

  beforeAll(async () => {
    if (!databaseUrl) {
      throw new Error('DATA_SURFACE_STORE_TEST_DATABASE_URL is required.');
    }
    const parsed = new URL(databaseUrl);
    if (!['localhost', '127.0.0.1', '::1'].includes(parsed.hostname)) {
      throw new Error(
        'Data surface store integration tests require localhost.',
      );
    }
    const db = await resolveDatabase(
      { type: 'postgres', url: databaseUrl },
      { dbid: `data-surface-store-test-${randomUUID()}` },
    );
    store = new SmrtDataSurfaceActionStateStore(db);
  });

  function tokenRecord(overrides: { expiresAt?: number } = {}) {
    return {
      expiresAt: overrides.expiresAt ?? Date.now() + 5 * 60 * 1000,
      actorUserId: `user-${randomUUID()}`,
      tenantId: null,
      onBehalfOfUserId: null,
      actsAsProfileId: null,
      agentClass: 'iolaus/owner',
      identityKey: 'admin-opportunities:table',
      actionId: 'review',
      actionFingerprint: `action-${randomUUID()}`,
      revision: 0,
      queryFingerprint: `query-${randomUUID()}`,
      selectionFingerprint: `selection-${randomUUID()}`,
      resolvedRowsFingerprint: `rows-${randomUUID()}`,
      requestFingerprint: `request-${randomUUID()}`,
    };
  }

  it('round-trips every preview token column through the real table', async () => {
    const token = `tok-${randomUUID()}`;
    const record = tokenRecord();

    await store.putToken(token, record);

    // Every field the adapter later compares the request against has to
    // survive the round trip; a column that silently did not persist would
    // turn into `confirmation_mismatch` on the first real apply.
    expect(await store.getToken(token)).toEqual({ ...record, consumedBy: '' });
    expect(await store.getToken(`missing-${randomUUID()}`)).toBeUndefined();
  });

  it('lets one idempotency key consume a live token and refuses another', async () => {
    const token = `tok-${randomUUID()}`;
    await store.putToken(token, tokenRecord());
    const key = `key-${randomUUID()}`;

    expect(await store.markTokenConsumed(token, key)).toBe(true);
    expect(await store.markTokenConsumed(token, key)).toBe(true);
    expect(await store.markTokenConsumed(token, `key-${randomUUID()}`)).toBe(
      false,
    );
  });

  it('refuses a first consumption of an already expired token', async () => {
    const token = `tok-${randomUUID()}`;
    // The deadline is evaluated by PostgreSQL, so this asserts the real
    // comparison rather than a stand-in's arithmetic.
    await store.putToken(token, tokenRecord({ expiresAt: Date.now() - 1000 }));

    expect(await store.markTokenConsumed(token, `key-${randomUUID()}`)).toBe(
      false,
    );
  });

  it('gives the reservation to exactly one concurrent attempt', async () => {
    const key = `scope-${randomUUID()}`;
    const fingerprint = `request-${randomUUID()}`;

    const [first, second] = await Promise.all([
      store.reserveIdempotency(key, {
        requestFingerprint: fingerprint,
        ownerToken: 'owner-a',
        reservedAt: Date.now(),
      }),
      store.reserveIdempotency(key, {
        requestFingerprint: fingerprint,
        ownerToken: 'owner-b',
        reservedAt: Date.now(),
      }),
    ]);

    // `ON CONFLICT (scope_key) DO NOTHING` is the arbitration point, so it
    // must resolve against a real unique index, not just parse. Both callers
    // are told the same winner: the loser reads the existing record rather
    // than being handed ownership it could use to complete another's work.
    const owners = [first, second].map((record) =>
      record.status === 'reserved' ? record.ownerToken : '',
    );
    expect(new Set(owners).size).toBe(1);
    expect(['owner-a', 'owner-b']).toContain(owners[0]);
    // Exactly one attempt owns the reservation, so exactly one can complete it.
    const winner = owners[0];
    const loser = winner === 'owner-a' ? 'owner-b' : 'owner-a';
    expect(await store.completeIdempotency(key, loser, result)).toBe(false);
    expect(await store.completeIdempotency(key, winner, result)).toBe(true);
  });

  it('completes a reservation only for its owner and replays the result', async () => {
    const key = `scope-${randomUUID()}`;
    await store.reserveIdempotency(key, {
      requestFingerprint: 'request-fp',
      ownerToken: 'owner-a',
      reservedAt: Date.now(),
    });

    expect(await store.completeIdempotency(key, 'owner-b', result)).toBe(false);
    expect(await store.completeIdempotency(key, 'owner-a', result)).toBe(true);

    const stored = await store.getIdempotency(key);
    expect(stored).toMatchObject({ status: 'completed' });
    // The result column round-trips as JSON, which is what a replay returns
    // instead of applying the action a second time.
    expect(stored?.status === 'completed' ? stored.result : null).toEqual(
      result,
    );
    // A completed record is no longer completable or releasable.
    expect(await store.completeIdempotency(key, 'owner-a', result)).toBe(false);
    expect(await store.releaseIdempotency(key, 'owner-a')).toBe(false);
  });

  it('releases a reservation so the key can be reserved again', async () => {
    const key = `scope-${randomUUID()}`;
    await store.reserveIdempotency(key, {
      requestFingerprint: 'request-fp',
      ownerToken: 'owner-a',
      reservedAt: Date.now(),
    });

    expect(await store.releaseIdempotency(key, 'owner-b')).toBe(false);
    expect(await store.releaseIdempotency(key, 'owner-a')).toBe(true);
    expect(await store.getIdempotency(key)).toBeUndefined();
  });
});
